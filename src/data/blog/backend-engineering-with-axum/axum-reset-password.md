---
title: "Axum Backend Series: Implementing Password Reset"
description: "Implementing password reset system and forget password system"
pubDatetime: 2025-10-04T19:30:00Z
tags: ["rust", "axum", "backend", "email", "password-reset", "auth"]
series: "Backend Engineering in Axum"
seriesOrder: 6
featured: true
ogImage: ../../../assets/images/axum-backend-engineering/reset-password/reset-password-cover-image.png
---


In this post, we are going to implement our password reset system using which users who forget their passwords can request a reset link, receive it via email and then they can set a new password.

Get the source code from here -> https://github.com/0xshadow-dev/realworld-axum-api
## Password Reset Flow
Let me explain the flow before implementing the entire thing.
1. User requests reset → Clicks "Forgot Password", enters their email
2. System generates token → Creates a time-limited, single-use token (1 hour expiration)
3. Email sent → User receives reset link with token
4. User clicks link → Opens form to enter new password
5. System validates → Checks token is valid and not expired
6. Password updated → Hash new password, update database, delete token

Ok, lets start working on building this system.
## Database Migration
Same as email verification, we need a table to store password reset tokens but with shorter expiration duration.

Let's start by creating a new migration file:
```bash
sqlx migrate add create_password_reset_tokens
```

After running this, you should get a sql file `migrations/0004_create_password_reset_tokens.sql`.

Now, add the following code to that file:
```sql
-- Migration 0004: Create password reset tokens table

CREATE TABLE password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX idx_password_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
```
This is very similar to email verification token schema. We are keeping these 2 schema separate because these 2 have different expiration policies and its easier to audit and manage separately.

Now, lets finally run the migration:
```bash
sqlx migrate run
```

> before running the migration, remember to start your container otherwise it'll return an error as it can't connect to the DB.

You should see an output like this:
```bash
❯ sqlx migrate run
Applied 4/migrate create password reset tokens (19.648666ms)
```

## Create Password Reset Token Model
Now, lets focus on creating the password reset token model.
Create a file `src/models/password_reset_token.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PasswordResetToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl PasswordResetToken {
    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }
}
```
This is the same pattern as email verification, we are keeping the expiration check as a method for cleaner code.

Now, update the `src/models/mod.rs` file:
```rust
pub mod user;
pub mod email_verification_token;
pub mod password_reset_token;

pub use user::User;
pub use email_verification_token::EmailVerificationToken;
pub use password_reset_token::PasswordResetToken;
```


## Create Password Reset Repository Trait
Now, its time to create the password reset repository trait
```rust
use async_trait::async_trait;
use sqlx::Error as SqlxError;
use uuid::Uuid;
use crate::models::{User, EmailVerificationToken, PasswordResetToken};

// ... existing traits ...

#[async_trait]
pub trait PasswordResetRepositoryTrait: Send + Sync {
    async fn create_token(
        &self,
        user_id: Uuid,
        token: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<PasswordResetToken, SqlxError>;

    async fn find_by_token(&self, token: &str) -> Result<Option<PasswordResetToken>, SqlxError>;

    async fn delete_token(&self, token: &str) -> Result<(), SqlxError>;

    async fn delete_all_user_tokens(&self, user_id: Uuid) -> Result<(), SqlxError>;
}
```

Here, we are doing the similar thing that we did for email verification. We are creating a trait and adding basic CRUD methods to this trait. There is just one addition:
`delete_all_user_tokens`. When a user successfully resets their password, we invalidate ALL their reset tokens. If someone requested multiple resets, only one should work.

## Implement Password Reset Repository
Now, that we have our password reset trait, we can now write the concrete implementation for password reset repository.

Create a file `src/repositories/password_reset_repository.rs`:
```rust
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::traits::PasswordResetRepositoryTrait;
use crate::models::PasswordResetToken;

#[derive(Clone)]
pub struct PasswordResetRepository {
    db: PgPool,
}

impl PasswordResetRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }
}

#[async_trait]
impl PasswordResetRepositoryTrait for PasswordResetRepository {
    async fn create_token(
        &self,
        user_id: Uuid,
        token: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<PasswordResetToken, sqlx::Error> {
        let reset_token = sqlx::query_as::<_, PasswordResetToken>(
            r#"
            INSERT INTO password_reset_tokens (user_id, token, expires_at)
            VALUES ($1, $2, $3)
            RETURNING id, user_id, token, expires_at, created_at
            "#,
        )
        .bind(user_id)
        .bind(token)
        .bind(expires_at)
        .fetch_one(&self.db)
        .await?;

        Ok(reset_token)
    }

    async fn find_by_token(&self, token: &str) -> Result<Option<PasswordResetToken>, sqlx::Error> {
        let reset_token = sqlx::query_as::<_, PasswordResetToken>(
            r#"
            SELECT id, user_id, token, expires_at, created_at
            FROM password_reset_tokens
            WHERE token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.db)
        .await?;

        Ok(reset_token)
    }

    async fn delete_token(&self, token: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM password_reset_tokens
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
            DELETE FROM password_reset_tokens
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
Standard repository pattern. The `delete_all_user_tokens` method is there so that when someone successfully resets their password, all pending reset requests become invalid.

Update `src/repositories/mod.rs`:
```rust
mod traits;
mod user_repository;
mod email_verification_repository;
mod password_reset_repository;

pub use traits::{UserRepositoryTrait, EmailVerificationRepositoryTrait, PasswordResetRepositoryTrait};
pub use user_repository::UserRepository;
pub use email_verification_repository::EmailVerificationRepository;
pub use password_reset_repository::PasswordResetRepository;
```
## Add Password Update to User Repository
Now, that we have finished the setup for password reset system, its time to update the user repository trait and the concrete implementation to have a method just to let user update their password.

Let's open the `src/repositories/traits.rs` file and add this method to `UserRepositoryTrait`:
```rust
#[async_trait]
pub trait UserRepositoryTrait: Send + Sync {
    // ... existing methods ...

    async fn update_password(
        &self,
        user_id: Uuid,
        new_password_hash: &str,
    ) -> Result<(), SqlxError>;
}
```

Now as explained previously, we need implement all the methods that are in the trait, hence now we need to implement this new method in the concrete user repository implementation too.

```rust
#[async_trait]
impl UserRepositoryTrait for UserRepository {
    // ... existing implementations ...

    async fn update_password(
        &self,
        user_id: Uuid,
        new_password_hash: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE users
            SET password_hash = $2
            WHERE id = $1
            "#,
        )
        .bind(user_id)
        .bind(new_password_hash)
        .execute(&self.db)
        .await?;

        Ok(())
    }
}
```
Simple update query - just the password hash, nothing else.

## Update Email Service
Just like we wrote a method at email service for email verification, we will write a method for password reset email too.

Open `src/services/email_service.rs` and add this method:
```rust
pub async fn send_password_reset_email(
    &self,
    to_email: &str,
    username: &str,
    reset_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let base_url = env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let reset_link = format!("{}/api/auth/reset-password?token={}", base_url, reset_token);

    let html_body = format!(
        r#"
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                .header {{ background-color: #f8d7da; color: #721c24; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }}
                .content {{ background-color: #fff; padding: 30px; border: 1px solid #ddd; }}
                .button {{ display: inline-block; padding: 12px 24px; background-color: #dc3545; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }}
                .footer {{ text-align: center; margin-top: 20px; color: #666; font-size: 12px; }}
                .warning {{ background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 20px 0; }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Password Reset Request</h1>
                </div>
                <div class="content">
                    <h2>Hi {}!</h2>
                    <p>We received a request to reset your password. If you didn't make this request, you can safely ignore this email.</p>
                    <p>To reset your password, click the button below:</p>
                    <div style="text-align: center;">
                        <a href="{}" class="button">Reset Password</a>
                    </div>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="background-color: #eee; padding: 10px; word-break: break-all;">{}</p>
                    <div class="warning">
                        <p><strong>⚠️ Security Notice:</strong></p>
                        <ul>
                            <li>This link will expire in 1 hour</li>
                            <li>The link can only be used once</li>
                            <li>If you didn't request this reset, someone may be trying to access your account</li>
                        </ul>
                    </div>
                    <p>After clicking the link, you'll be able to create a new password for your account.</p>
                </div>
                <div class="footer">
                    <p>© 2024 AxumAPI. All rights reserved.</p>
                    <p>If you have security concerns, please contact our support team immediately.</p>
                </div>
            </div>
        </body>
        </html>
        "#,
        username, reset_link, reset_link
    );

    let email = Message::builder()
        .from(self.from_email.clone())
        .to(to_email.parse()?)
        .subject("Reset Your Password")
        .header(ContentType::TEXT_HTML)
        .body(html_body)?;

    self.mailer.send(&email)?;

    println!("Password reset email sent to {}", to_email);
    println!("Reset link: {}", reset_link);

    Ok(())
}
```

This is also very similar to the mail verification email template but changed a bit. There is nothing new to explain, just a different template, different redirect URL and the email builder.

## Create Request/Response DTO
Now, lets create the request/response DTOs for forget password and reset password reset requests and responses.

Create `src/schemas/password_reset_schemas.rs`:
```rust
use serde::{Deserialize, Serialize};
use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct ForgotPasswordRequest {
    #[validate(email(message = "Invalid email format"))]
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct ForgotPasswordResponse {
    pub message: String,
}

#[derive(Debug, Deserialize, Validate)]
pub struct ResetPasswordRequest {
    pub token: String,
    #[validate(length(min = 8, message = "Password must be at least 8 characters"))]
    pub new_password: String,
}

#[derive(Debug, Serialize)]
pub struct ResetPasswordResponse {
    pub message: String,
}
```

Simple request/response structures with validation:
- Email format validation for forgot password
- Minimum password length for reset (8 characters)

Update `src/schemas/mod.rs`:
```rust
pub mod auth_schemas;
pub mod password_reset_schemas;
```

## Update AppState
Open `src/state.rs` and add the password reset repository:

```rust
use std::sync::Arc;
use crate::repositories::{
    UserRepository,
    UserRepositoryTrait,
    EmailVerificationRepository,
    EmailVerificationRepositoryTrait,
    PasswordResetRepository,
    PasswordResetRepositoryTrait,
};
use crate::services::EmailService;
use axum::extract::FromRef;
use sqlx::PgPool;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub db: PgPool,
    pub user_repository: Arc<dyn UserRepositoryTrait>,
    pub email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait>,
    pub password_reset_repository: Arc<dyn PasswordResetRepositoryTrait>,
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

        let email_service = Arc::new(
            EmailService::new().expect("Failed to initialize email service")
        );

        Ok(Self {
            db,
            user_repository,
            email_verification_repository,
            password_reset_repository,
            email_service,
        })
    }
}
```
We have done this a lot, again nothing new to explain. Just adding the repository to initialize it at runtime. Please read the previous article if its not clear to you.
## Implement Password Reset Handlers
Create the handlers in `src/handlers/auth.rs`. Add these two functions:

```rust
use crate::schemas::password_reset_schemas::*;

// Handler for "Forgot Password" - generates and emails reset token
pub async fn forgot_password(
    State(state): State<AppState>,
    Json(payload): Json<ForgotPasswordRequest>,
) -> Result<Json<ForgotPasswordResponse>, StatusCode> {
    // Validate email format
    payload
        .validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // Look up user by email
    let user = state
        .user_repository
        .find_by_email(&payload.email)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // SECURITY: Always return success even if email doesn't exist
    // This prevents attackers from discovering which emails are registered
    if user.is_none() {
        return Ok(Json(ForgotPasswordResponse {
            message: "If that email exists, a password reset link has been sent.".to_string(),
        }));
    }

    let user = user.unwrap();

    // Generate reset token
    let reset_token = generate_verification_token();
    let expires_at = Utc::now() + Duration::hours(1); // 1 hour expiration

    // Save token to database
    state
        .password_reset_repository
        .create_token(user.id, &reset_token, expires_at)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Send reset email
    state
        .email_service
        .send_password_reset_email(&user.email, &user.username, &reset_token)
        .await
        .map_err(|e| {
            eprintln!("Failed to send password reset email: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(Json(ForgotPasswordResponse {
        message: "If that email exists, a password reset link has been sent.".to_string(),
    }))
}

// Handler for actually resetting the password
pub async fn reset_password(
    State(state): State<AppState>,
    Json(payload): Json<ResetPasswordRequest>,
) -> Result<Json<ResetPasswordResponse>, StatusCode> {
    // Validate new password
    payload
        .validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // Look up token
    let reset_token = state
        .password_reset_repository
        .find_by_token(&payload.token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Check expiration
    if reset_token.is_expired() {
        // Clean up expired token
        state
            .password_reset_repository
            .delete_token(&payload.token)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return Err(StatusCode::GONE);
    }

    // Hash new password
    let new_password_hash = hash_password(&payload.new_password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Update user password
    state
        .user_repository
        .update_password(reset_token.user_id, &new_password_hash)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Delete ALL reset tokens for this user (invalidate any other pending requests)
    state
        .password_reset_repository
        .delete_all_user_tokens(reset_token.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ResetPasswordResponse {
        message: "Password has been reset successfully. You can now login with your new password.".to_string(),
    }))
}
```

Let me explain what's going on in here. I won't explain the code as its too much repetition . I'll just explain what are we doing in each handler and in the exact order:
### `forgot_password` Handler
1. Check if email format is valid
2. Search database for user with that email
3. If user doesn't exist, pretend we sent an email anyway (security)
4. If user exists, create a random token
5. Calculate expiration time (1 hour from now)
6. Save token in database linked to that user's ID
7. Send email with the token
8. Return same success message regardless of whether user existed

## `reset_password` Handler
1. Check if new password meets requirements (minimum 8 characters)
2. Look up the token in database
3. If token doesn't exist, return error
4. Check if token is expired
5. If expired, delete it and return error
6. Hash the new password
7. Update the user's password (we know which user from the token's user_id)
8. Delete all password reset tokens for that user
9. Return success message

That's it. The first handler creates and sends the token. The second handler validates the token and changes the password.

## Update Routes
Update `src/handlers/mod.rs`:

```rust
pub mod auth;
pub mod health;

pub use auth::{
    register, login, current_user, verify_email,
    forgot_password, reset_password
};
pub use health::health_check;
```

## Update `src/main.rs`:
Let's update `main.rs` and add the new endpoints.
```rust
use realworld_axum_api::{
    handlers::{
        register, login, current_user, verify_email,
        forgot_password, reset_password, health_check
    },
    state::AppState,
};

// In the router
let app = Router::new()
    .route("/health", get(health_check))
    .route("/api/users", post(register))
    .route("/api/users/login", post(login))
    .route("/api/user", get(current_user))
    .route("/api/auth/verify-email", get(verify_email))
    .route("/api/auth/forgot-password", post(forgot_password))
    .route("/api/auth/reset-password", post(reset_password))
    .with_state(app_state);
```

## Test the Complete Flow

Build and run:
```bash
cargo build
cargo run
```

I'm going to use curl commands instead of any software as they take lot of page space and I think that's completely unnecessary. I'll explain all the curl commands, that way you can either use these curl commands or use the software you want to test the API.
### Test Forgot Password

Request a reset:
```bash
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com"
  }'
```

We are sending a forgot password POST request with the user's email ID.

Response:
```json
{
  "message": "If that email exists, a password reset link has been sent."
}
```

Check your terminal for the reset link, or look in Mailtrap for the email.
> You'll see the email correctly but clicking on the button on the email or opening the reset link in a browser won't work as browser by default sents a GET request and we need to send a POST request. Hence, we need to build a frontend to handle that. For now, just copy the token and follow the below curl commands.

### Test with Non-Existent Email

Try an email that doesn't exist:
```bash
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "doesnotexist@example.com"
  }'
```

Same response, we don't reveal whether the email exists:

```json
{
  "message": "If that email exists, a password reset link has been sent."
}
```

### Test Password Reset

Use the token from the email:
```bash
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_RESET_TOKEN_HERE",
    "new_password": "newsecurepassword123"
  }'
```
Here, we are doing a POST request to `reset-password` endpoint and in the body we are keeping the token that we got in our mail and the new password.

>I'm just explaining the flow again.
>User requests reset with email → API generates random token, saves it linked to user_id in database, emails the token → User submits token + new password → API looks up which user_id owns that token and updates their password.
>The token acts as temporary proof of identity because only the real email owner can access it.


Response:
```json
{
  "message": "Password has been reset successfully. You can now login with your new password."
}
```

### Test Login with New Password

Verify the password was actually changed:
```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "email": "test@example.com",
      "password": "newsecurepassword123"
    }
  }'
```

You should get a JWT token back, confirming the password reset worked.

### Test Expired Token
Wait for the token to expire (1 hour), or manually delete it from the database, then try to use it:

```bash
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "EXPIRED_TOKEN",
    "new_password": "shouldnotwork"
  }'
```

You'll get HTTP 410 GONE, indicating the token existed but is no longer valid.

## Conclusion
We finally finished our forgot password feature that a lot of other webapps and apps provide. I think its great that we also understood about email sending and how to use external service. This article is kind of a reinforcement of the knowledge gained on the previous article.

In the next article, we will get back to our auth and work on adding refresh token.

One more thing, I'm starting a new series in a few days where we will build a coding agent in rust and incrementally update it with different approaches. I don't want it to be other tutorials where they are only building a toy coding agent. I want it to build to actually learn and use. Lets see how that goes. See you soon
