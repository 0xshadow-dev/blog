---
title: "Axum Backend Series: JWT with Refresh Token"
description: "Implementing refresh token for jwt authentication in axum"
pubDatetime: 2025-10-14T19:30:00Z
tags: ["rust", "axum", "backend", "refresh-token", "jwt", "auth"]
series: "Backend Engineering in Axum"
seriesOrder: 7
featured: true
ogImage: ../../../assets/images/axum-backend-engineering/refresh-token/axum-refresh-token-cover-image.png
---

In this post, we're going to level up our JWT authentication system by adding refresh tokens. We've been working with access tokens, and now it's time to make our auth system more secure and user-friendly by introducing refresh tokens.

Let me explain what refresh tokens are and why we need it.

Get the source code from here -> https://github.com/0xshadow-dev/realworld-axum-api
## Understanding Refresh Tokens
Before we start coding, let's understand what refresh tokens are and the problems they solve.
### The Problem with Single JWT Tokens
Right now, our system uses one JWT token that's valid for 24 hours. This creates two problems that we need to work on.
#### Problem 1: Long-lived tokens are dangerous

Imagine someone steals your JWT token - maybe through an XSS attack, network sniffing on public WiFi, or from a stolen device. Here's what happens:
- The attacker has complete access to your account for 24 hours
- You cannot revoke the token because JWTs are stateless - the server doesn't track them
- You're stuck waiting the full 24 hours for the token to expire naturally
This is a huge problem for us.
#### Problem 2: Short-lived tokens are annoying
Ok, you might think, "let's just make tokens expire in 5 minutes or in some other short duration"

But then:
- Users get kicked out every 5 minutes
- They have to re-enter their credentials constantly
- The user experience becomes terrible
- Users will likely choose weak, easy-to-remember passwords out of frustration

We need a solution that's both secure AND convenient.
### The Solution: Two Types of Tokens
Instead of using one token that tries to do everything, we split the responsibility into two different tokens, each with its own specific job.

#### Access Token (Short-lived)
- Expires in 15 minutes
- Used for every API request
- JWT format, its stateless and self-contained
- If stolen, only works for a short window of 15 minutes

#### Refresh Token (Long-lived)
- Expires in 7-30 days, or never (we'll start with no expiration)
- Used ONLY to get new access tokens, never for API requests
- Random UUID string, not a JWT
- Stored in the database so we can revoke it anytime
- If stolen, can be detected and immediately deleted (We will learn how to handle this in future article)

### How It Works: The Complete Flow

Let me walk you through how a typical user session works with this dual-token system.
- User logs in with their email and password. The server validates the credentials and generates two tokens: an access token (JWT, expires in 15 minutes) and a refresh token (UUID, saved to database). Both tokens are sent back to the client.
- For the next 15 minutes, the user makes requests normally. Each request includes the access token in the Authorization header. The server validates the JWT and returns the requested data. We are not changing anything here.
- After 15 minutes, when the client tries to make a request with the expired access token, the server checks the JWT, sees it's expired, and returns 401 Unauthorized.
- Instead of asking the user to login again, the client or frontend (the frontend developer needs to handle this, we are keeping it this way for now to make our life simpler, we might change this in future) uses the refresh token. It sends a POST request to `/api/auth/refresh` with the refresh token. The server looks up the token in the database, and if it exists, generates a new access token with 15 minutes validity and returns it to the client.
- Every 15 minutes, this refresh cycle repeats automatically in the background.From the user's perspective, they're just using the app normally, but behind the scenes, the frontend is managing token expiration and refresh.

In this lesson, we'll implement access tokens that expire in 15 minutes, refresh tokens with no expiration (indefinite), the `/api/auth/refresh` endpoint to exchange refresh tokens for new access tokens, database storage for refresh tokens, and updated Login/Register endpoints that return both tokens. We're intentionally skipping logout functionality for now, we'll implement proper session management in a future lesson.

Now let's build it.
## Database Setup

Just like we did with email verification and password reset, we need to set up a database table to store refresh tokens. We store these in the database so we can validate them and revoke them whenever needed.

### Create the Migration
Let's create a new migration:
```bash
sqlx migrate add create_refresh_tokens
```
After running this command, you'll get a new file: `migrations/0005_create_refresh_tokens.sql`.

### Add the Schema
Open that file and add this code:
```sql
-- Migration 0005: Create refresh tokens table

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
```

Notice what we're NOT including an `expires_at` column. We'll add that in the next lesson when we learn about token rotation and expiration strategies.

Let me explain what we wrote above:
- `id`: Primary key, auto-generated UUID
- `user_id`: Links the token to a specific user, with foreign key constraint
- `token`: The actual refresh token string (UUID)
- `created_at`: When the token was created
- `last_used_at`: Tracks when the token was last used - useful for monitoring and detecting suspicious activity
- `ON DELETE CASCADE`: If we delete a user, all their refresh tokens get deleted automatically. You have seen it multiple times, I hope you now understand this very well.

The indexes on `token` and `user_id` make lookups fast when validating tokens or finding all tokens for a user. We have done this a bunch of times, so nothing new to explain.

### Run the Migration
Make sure your PostgreSQL container is running, then:
```bash
sqlx migrate run
```

You should see:
```bash
Applied 5/migrate create refresh tokens (15.234ms)
```
## Create the Refresh Token Model
Time to create the Rust struct that represents our refresh token. This is the same pattern we've used for all our other models.

Create `src/models/refresh_token.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RefreshToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}
```

This is straightforward, we're just mirroring the database schema in Rust. The `FromRow` derive macro lets SQLx automatically convert database rows into this struct, and `Serialize`/`Deserialize` handle JSON conversion.

Now update `src/models/mod.rs`:
```rust
pub mod user;
pub mod email_verification_token;
pub mod password_reset_token;
pub mod refresh_token; // NEW

pub use user::User;
pub use email_verification_token::EmailVerificationToken;
pub use password_reset_token::PasswordResetToken;
pub use refresh_token::RefreshToken; // NEW
```

Just adding our new model to the exports so we can use it throughout the application.
## Create Refresh Token Repository
As we know, its time to create the repository for refresh tokens. We have done this multiple times in our previous aritcles.
### Add the Trait
First, lets create a trait for the repository. Open `src/repositories/traits.rs` and add this trait at the end:
```rust
#[async_trait]
pub trait RefreshTokenRepositoryTrait: Send + Sync {
    async fn create_token(
        &self,
        user_id: Uuid,
        token: &str,
    ) -> Result<RefreshToken, SqlxError>;

    async fn find_by_token(&self, token: &str) -> Result<Option<RefreshToken>, SqlxError>;

    async fn update_last_used(&self, token: &str) -> Result<(), SqlxError>;

    async fn delete_token(&self, token: &str) -> Result<(), SqlxError>;

    async fn delete_all_user_tokens(&self, user_id: Uuid) -> Result<(), SqlxError>;
}
```

Make sure to add `RefreshToken` to your imports at the top of the file. Your IDE should give you suggestion but if not, then please add this:

```rust
use crate::models::{EmailVerificationToken, PasswordResetToken, RefreshToken, User};
```

We are just adding usual CRUD methods, we won't use the delete methods in this article but those are for future articles.
### Implement the Repository
After creating the trait, now we can create the repository.
Create `src/repositories/refresh_token_repository.rs`:

```rust
use async_trait::async_trait;
use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use super::traits::RefreshTokenRepositoryTrait;
use crate::models::RefreshToken;

#[derive(Clone)]
pub struct RefreshTokenRepository {
    db: PgPool,
}

impl RefreshTokenRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }
}

#[async_trait]
impl RefreshTokenRepositoryTrait for RefreshTokenRepository {
    async fn create_token(
        &self,
        user_id: Uuid,
        token: &str,
    ) -> Result<RefreshToken, sqlx::Error> {
        let refresh_token = sqlx::query_as::<_, RefreshToken>(
            r#"
            INSERT INTO refresh_tokens (user_id, token)
            VALUES ($1, $2)
            RETURNING id, user_id, token, created_at, last_used_at
            "#,
        )
        .bind(user_id)
        .bind(token)
        .fetch_one(&self.db)
        .await?;

        Ok(refresh_token)
    }

    async fn find_by_token(&self, token: &str) -> Result<Option<RefreshToken>, sqlx::Error> {
        let refresh_token = sqlx::query_as::<_, RefreshToken>(
            r#"
            SELECT id, user_id, token, created_at, last_used_at
            FROM refresh_tokens
            WHERE token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.db)
        .await?;

        Ok(refresh_token)
    }

    async fn update_last_used(&self, token: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE refresh_tokens
            SET last_used_at = $1
            WHERE token = $2
            "#,
        )
        .bind(Utc::now())
        .bind(token)
        .execute(&self.db)
        .await?;

        Ok(())
    }

    async fn delete_token(&self, token: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM refresh_tokens
            WHERE token = $1
            "#,
        )
        .bind(token)
        .execute(&self.db)
        .await?;

        Ok(())
    }

    async fn delete_all_user_tokens(&self, user_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM refresh_tokens
            WHERE user_id = $1
            "#,
        )
        .bind(user_id)
        .execute(&self.db)
        .await?;

        Ok(())
    }
}
```

We are doing the similar thing that we did for other repositories, just adding CRUD operations to our repository. The `update_last_used` method is particularly interesting,  every time someone uses their refresh token to get a new access token, we'll update this timestamp. This creates an audit trail that helps us detect suspicious activity, like a token being used from multiple locations simultaneously. It's not required right now but we will need it in the next article, hence wrote it right now.

Now, update `src/repositories/mod.rs`:
```rust
mod traits;
mod user_repository;
mod email_verification_repository;
mod password_reset_repository;
mod refresh_token_repository;

pub use traits::{
    UserRepositoryTrait,
    EmailVerificationRepositoryTrait,
    PasswordResetRepositoryTrait,
    RefreshTokenRepositoryTrait,
};
pub use user_repository::UserRepository;
pub use email_verification_repository::EmailVerificationRepository;
pub use password_reset_repository::PasswordResetRepository;
pub use refresh_token_repository::RefreshTokenRepository;
```
## Create Token Generation Utility
We need a function to generate random refresh tokens. Unlike JWTs which contain encoded data and signatures, refresh tokens are just random strings. We'll use UUIDs for this.

Create `src/auth/tokens.rs`:
```rust
use uuid::Uuid;

pub fn generate_refresh_token() -> String {
    // Generate a random UUID and convert to string
    // This creates a unique, unpredictable token
    Uuid::new_v4().to_string()
}
```

That's it.

Now just update `src/auth/mod.rs`:
```rust
pub mod jwt;
pub mod middleware;
pub mod password;
pub mod tokens;
```

## Update JWT for Access Tokens
We need to make our JWT access tokens much shorter-lived. Open `src/auth/jwt.rs` and find the `generate_token` function. Change the expiration from 24 hours to 15 minutes:
```rust
pub fn generate_token(user_id: &Uuid, secret: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let now = Utc::now();

    // Changed from 24 hours to 15 minutes
    let exp = (now + Duration::minutes(15)).timestamp() as usize;
    let iat = now.timestamp() as usize;

    let claims = Claims {
        sub: user_id.to_string(),
        exp,
        iat,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )
}
```

Now our access tokens only last 15 minutes. After that, they expire and the client needs to use the refresh token to get a new one.

**How this will work with a frontend:** When your frontend gets a 401 Unauthorized response indicating an expired access token, then the frontend should call the `/api/auth/refresh` endpoint with the refresh token. The backend responds with a fresh access token, and the frontend retries the original request, all happening transparently without the user noticing.

> For simplicity, we are keeping this responsibility with frontend and focusing on keeping our backend simple for education purpose. We might change this in future but for now, lets stick with this approach.
## Update Request/Response Schemas
We need to update our authentication schemas to handle both tokens. Now, lets refactor somethings.
First, we will remove the need of sending token while sending user data that's not needed as user already got the access token and they are using that token to access the endpoints.
Second, we will create a separate schema for login response, that'll send user data, access and refresh token. So that after login, the frontend can take those 2 tokens and store it safely for future use.
### Update Login Response
Open `src/schemas/auth_schemas.rs` and update it:

```rust
use serde::{Deserialize, Serialize};
use validator::Validate;

// ... existing RegisterUserRequest, RegisterUserData, LoginUserRequest, LoginUserData ...

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub user: UserData,
    pub access_token: String,   // New: separate access token
    pub refresh_token: String,  // New: refresh token
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub user: UserData,
}

#[derive(Debug, Serialize)]
pub struct UserData {
    pub email: String,
    pub username: String,
    pub bio: String,
    pub image: Option<String>,
    pub email_verified: bool,
}

impl UserData {
    pub fn from_user(user: crate::models::User) -> Self {
        Self {
            email: user.email,
            username: user.username,
            bio: user.bio.unwrap_or_default(),
            image: user.image,
            email_verified: user.email_verified,
        }
    }
}
```

Let me explain the changes here:
- Created a separate `LoginResponse` struct specifically for login/register endpoints that return both tokens
- `UserResponse` is now used for endpoints that don't need tokens, like `/api/user`
- Removed the `token` field from `UserData` - tokens are now at the response level, not mixed in with user data
- Added a convenience method `from_user` to convert a `User` model into `UserData`

> I've changed the `from_user` from `from_user_with_token` and that method is not taking the token anymore. So replace this method with the current one. If you are confused, please check the code from github repo.

### Create Token Schemas
Create `src/schemas/token_schemas.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct RefreshTokenResponse {
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
pub struct LogoutRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct LogoutResponse {
    pub message: String,
}
```

These are the request/response structures for token operations. The refresh request accepts a refresh token and returns a new access token. The logout structures are here for future use when we implement proper session management.

Update `src/schemas/mod.rs`:
```rust
pub mod auth_schemas;
pub mod password_reset_schemas;
pub mod token_schemas;
pub mod user_schemas;

pub use auth_schemas::*;
pub use password_reset_schemas::*;
pub use token_schemas::*;
pub use user_schemas::{CreateUserRequest, UpdateUserRequest, UserResponse};
```
## Update AppState
Open `src/state.rs` and add the refresh token repository to our application state:

```rust
use crate::repositories::{
    EmailVerificationRepository, EmailVerificationRepositoryTrait, PasswordResetRepository,
    PasswordResetRepositoryTrait, RefreshTokenRepository, RefreshTokenRepositoryTrait,
    UserRepository, UserRepositoryTrait,
};
use crate::services::EmailService;
use axum::extract::FromRef;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub db: PgPool,
    pub user_repository: Arc<dyn UserRepositoryTrait>,
    pub email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait>,
    pub password_reset_repository: Arc<dyn PasswordResetRepositoryTrait>,
    pub refresh_token_repository: Arc<dyn RefreshTokenRepositoryTrait>,
    pub email_service: Arc<EmailService>,
}

impl AppState {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let db = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations").run(&db).await?;

        let user_repository: Arc<dyn UserRepositoryTrait> =
            Arc::new(UserRepository::new(db.clone()));

        let email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait> =
            Arc::new(EmailVerificationRepository::new(db.clone()));

        let password_reset_repository: Arc<dyn PasswordResetRepositoryTrait> =
            Arc::new(PasswordResetRepository::new(db.clone()));

        let refresh_token_repository: Arc<dyn RefreshTokenRepositoryTrait> =
            Arc::new(RefreshTokenRepository::new(db.clone()));

        println!("Initializing email service...");
        let email_service = match EmailService::new() {
            Ok(service) => Arc::new(service),
            Err(e) => {
                eprintln!("Failed to initialize email service: {}", e);
                eprintln!("Make sure all SMTP env vars are set in .env");
                panic!("Email service initialization failed");
            }
        };

        Ok(Self {
            db,
            user_repository,
            email_verification_repository,
            password_reset_repository,
            refresh_token_repository,
            email_service,
        })
    }
}
```

Same pattern we've been using - initialize the repository at startup and make it available throughout the application via dependency injection.
## Update Login Handler
Now let's modify the login handler to generate and return both tokens.

Open `src/handlers/auth.rs` and update the `login` function:
```rust
use crate::auth::tokens::generate_refresh_token;

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginUserRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    // Validate input
    payload
        .user
        .validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // Find user by email
    let user = state
        .user_repository
        .find_by_email(&payload.user.email)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Verify password
    let password_valid = verify_password(&payload.user.password, &user.password_hash)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !password_valid {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Generate JWT access token (15 minutes)
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let access_token = generate_token(&user.id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Generate refresh token (UUID, no expiration)
    let refresh_token = generate_refresh_token();

    // Save refresh token to database
    state
        .refresh_token_repository
        .create_token(user.id, &refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Build response with BOTH tokens
    let response = LoginResponse {
        user: UserData::from_user(user),
        access_token,
        refresh_token,
    };

    Ok(Json(response))
}
```

Let me explain the changes:
1. We import the `generate_refresh_token` function
2. After generating the access token (JWT), we generate a refresh token (UUID)
3. We save the refresh token to the database - this is crucial because it means we can look it up later and delete it if needed
4. The response now includes both tokens: `access_token` and `refresh_token`

The client will store both tokens and use them appropriately, access token for API requests, refresh token only when the access token expires.

> Notice that we have changed the return type from `UserResponse` to `LoginResponse`.
## Update Register Handler
We need to do the same thing for registration. Find the `register` function and update the token generation part at the end:
```rust
pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterUserRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    eprintln!("REGISTER HANDLER CALLED");

    eprintln!("Validating...");
    payload
        .user
        .validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    eprintln!("Checking email exists...");
    if state
        .user_repository
        .find_by_email(&payload.user.email)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Err(StatusCode::CONFLICT);
    }

    eprintln!("Checking username exists...");
    if state
        .user_repository
        .find_by_username(&payload.user.username)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Err(StatusCode::CONFLICT);
    }

    eprintln!("Hashing password...");
    let password_hash = hash_password(&payload.user.password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    eprintln!("Creating user...");
    let user = state
        .user_repository
        .create(&payload.user.username, &payload.user.email, &password_hash)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    eprintln!("User created: {}", user.email);

    // Generate verification token
    let verification_token = generate_verification_token();
    let expires_at = Utc::now() + Duration::hours(24);

    eprintln!("Generated token: {}", verification_token);

    // Save token to database
    state
        .email_verification_repository
        .create_token(user.id, &verification_token, expires_at)
        .await
        .map_err(|e| {
            eprintln!("Failed to create token in DB: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    eprintln!("Token saved to database");

    // Send verification email
    eprintln!("Attempting to send email...");
    state
        .email_service
        .send_verification_email(&user.email, &user.username, &verification_token)
        .await
        .map_err(|e| {
            eprintln!("Failed to send verification email: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    eprintln!("Email sent successfully");

    // Generate JWT access token (15 minutes)
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let access_token = generate_token(&user.id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Generate refresh token (UUID, no expiration)
    let refresh_token = generate_refresh_token();

    // Save refresh token to database
    state
        .refresh_token_repository
        .create_token(user.id, &refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Build response with BOTH tokens
    let response = LoginResponse {
        user: UserData::from_user(user),
        access_token,
        refresh_token,
    };

    eprintln!("Registration complete");

    Ok(Json(response))
}
```

Same pattern - after creating the user and sending the verification email, we generate both tokens and save the refresh token to the database.
## Update Current User Handler
The `/api/user` endpoint needs a small update to use the new response type. Find the `current_user` function:
```rust
pub async fn current_user(
    RequireAuth(user): RequireAuth,
) -> Result<Json<UserResponse>, StatusCode> {
    // Build response (no token needed - they already have one)
    let response = UserResponse {
        user: UserData::from_user(user),
    };

    Ok(Json(response))
}
```

**Why no token here?** The user already sent a valid access token to access this endpoint, that's how they authenticated. We don't need to give them a new token unless they explicitly ask for one via the refresh endpoint. This endpoint just returns their user data.
## Implement Refresh Token Handler
Now, lets implement the endpoint that exchanges a refresh token for a new access token.

Add this new function to `src/handlers/auth.rs`:
```rust
use crate::schemas::token_schemas::*;

pub async fn refresh_token(
    State(state): State<AppState>,
    Json(payload): Json<RefreshTokenRequest>,
) -> Result<Json<RefreshTokenResponse>, StatusCode> {
    // Look up the refresh token in database
    let refresh_token = state
        .refresh_token_repository
        .find_by_token(&payload.refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Update last_used_at timestamp
    state
        .refresh_token_repository
        .update_last_used(&payload.refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Generate new access token
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let access_token = generate_token(&refresh_token.user_id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Return new access token
    Ok(Json(RefreshTokenResponse { access_token }))
}
```

Let me explain what's happening here:
- We search for the refresh token in the database. If it doesn't exist, we return 401 Unauthorized. This is a security check, the token must exist in our database.
- We record when the token was used. This creates an audit trail (remember I talked about it earlier) that helps detect suspicious activity.
- We create a brand new JWT access token with a fresh 15-minute expiration. The token contains the `user_id` we got from the refresh token lookup.
- Notice we don't return a new refresh token. The same refresh token continues to work until it's deleted or expires (which we haven't implemented yet).

> The refresh token itself doesn't change with each use. It stays valid until the user logs out or we manually revoke it. In the next lesson, we'll implement token rotation where each refresh operation generates a new refresh token for added security.
## Update Routes
Now let's set up the new endpoint.

Update `src/handlers/mod.rs`:
```rust
pub mod auth;
pub mod health;

pub use auth::{
    current_user, forgot_password, login, refresh_token, register, reset_password, verify_email,
};
pub use health::health_check;
```

Update `src/main.rs`:

```rust
use axum::{
    routing::{get, post},
    Router,
};
use std::env;

use realworld_axum_api::{
    handlers::{
        current_user, forgot_password, health_check, login, refresh_token, register,
        reset_password, verify_email,
    },
    state::AppState,
};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    let app_state = AppState::new(&database_url)
        .await
        .expect("Failed to connect to database");

    println!("Connected to database successfully!");

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/users", post(register))
        .route("/api/users/login", post(login))
        .route("/api/user", get(current_user))
        .route("/api/auth/verify-email", get(verify_email))
        .route("/api/auth/forgot-password", post(forgot_password))
        .route("/api/auth/reset-password", post(reset_password))
        .route("/api/auth/refresh", post(refresh_token))  // NEW
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://localhost:3000");
    println!("Available endpoints:");
    println!("  POST /api/users                  - Register new user");
    println!("  POST /api/users/login            - Login existing user");
    println!("  GET  /api/user                   - Get current user (requires auth)");
    println!("  GET  /api/auth/verify-email      - Verify email with token");
    println!("  POST /api/auth/forgot-password   - Request password reset");
    println!("  POST /api/auth/reset-password    - Reset password with token");
    println!("  POST /api/auth/refresh           - Get new access token");  // NEW
    println!("  GET  /health                     - Health check");

    axum::serve(listener, app).await.unwrap();
}
```

## Testing the Complete Flow
Now, lets test if everything works or not.
First, lets un the server:
```bash

cargo run
```

You should see:
```
Connected to database successfully!
Server running on http://localhost:3000
Available endpoints:
  POST /api/users                  - Register new user
  POST /api/users/login            - Login existing user
  GET  /api/user                   - Get current user (requires auth)
  GET  /api/auth/verify-email      - Verify email with token
  POST /api/auth/forgot-password   - Request password reset
  POST /api/auth/reset-password    - Reset password with token
  POST /api/auth/refresh           - Get new access token
  GET  /health                     - Health check
```

> I'm using the username and password that I created previously, you can use whatever user you created previously.
### Test 1: Login and Get Both Tokens

Let's login and see both tokens in response:
```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "email": "sam@test.com",
      "password": "passwordnew"
    }
  }'
```

Response:
```json
{
  "user": {
    "email": "sam@test.com",
    "username": "sam",
    "bio": "",
    "image": null,
    "email_verified": false
  },
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI1YzUzYWQxYy03MGUzLTRlMjItYmY5Ny0zYjA2NTFiNjhhMjQiLCJleHAiOjE3NjAzNzYxMzcsImlhdCI6MTc2MDM3NTIzN30.iA4a9TdM62LmK9guvDhXzOL836a01BQMKLenSIylCBk",
  "refresh_token": "057aaca0-a850-4a9c-9971-dd77c282d478"
}
```

We got both tokens. Save them somewhere, you'll need them for the next tests.
### Test 2: Use the Access Token
Now let's use the access token to make an authenticated request:

```bash
curl -X GET http://localhost:3000/api/user \
  -H "Authorization: Token YOUR_ACCESS_TOKEN_HERE"
```

Replace `YOUR_ACCESS_TOKEN_HERE` with the actual access token from the login response.

Response:

```json
{
  "user": {
    "email": "sam@test.com",
    "username": "sam",
    "bio": "",
    "image": null,
    "email_verified": false
  }
}
```

The access token works. For the next 15 minutes, you can use this token for all your API requests.

### Test 3: Wait for Token Expiration (Optional Fast Test)

You can wait the full 15 minutes, but for testing purposes, let's temporarily change the expiration to 1 minute. Open `src/auth/jwt.rs`:

```rust
let exp = (now + Duration::minutes(1)).timestamp() as usize;  // Changed from 15
```

Rebuild and login again to get a new short-lived token:

```bash
cargo build
cargo run
```

Then login again:

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "email": "sam@test.com",
      "password": "passwordnew"
    }
  }'
```

Wait about 61 seconds (just to be safe), then try using the access token:

```bash
curl -X GET http://localhost:3000/api/user \
  -H "Authorization: Token EXPIRED_ACCESS_TOKEN"
```

Response:

```
Status: 401 Unauthorized
```

Perfect, the access token expired and the server rejected it.

### Test 4: Refresh the Access Token

Now here's the magic - let's use the refresh token to get a new access token without logging in again:

```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "YOUR_REFRESH_TOKEN_HERE"
  }'
```

Replace `YOUR_REFRESH_TOKEN_HERE` with the refresh token you got from login (the UUID, not the JWT).

Response:

```json
{
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGc... (NEW TOKEN)"
}
```

You got a new access token. Notice that:
- You didn't have to enter your password again
- Only the access token is returned - the refresh token stays the same
- This new access token is valid for another 15 minutes (or 1 minute in our test setup)

> The refresh token acts like a "master key" that lets you get new access tokens without re-authenticating. But it's stored in the database, so we can revoke it anytime.

### Test 5: Use the New Access Token

Let's verify the new access token works:

```bash
curl -X GET http://localhost:3000/api/user \
  -H "Authorization: Token NEW_ACCESS_TOKEN_HERE"
```

Response:

```json
{
  "user": {
    "email": "sam@test.com",
    "username": "sam",
    "bio": "",
    "image": null,
    "email_verified": false
  }
}
```

You're authenticated again with the fresh access token.


## Conclusion
This is really great. We covered a lot of ground with this one. In the next one, we will improve this by working on that logout feature and refresh token expiry feature. Till then, happy learning. See you soon.
