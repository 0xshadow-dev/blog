---
title: "Axum Backend Series: Email Verification After Registration"
description: "Implementing email verification system after registration"
pubDatetime: 2025-10-01T19:30:00Z
tags: ["rust", "axum", "backend", "email"]
series: "Backend Engineering in Axum"
seriesOrder: 5
featured: true
ogImage: ../../../assets/images/axum-backend-engineering/email-verification/axum-email-verification-cover-image.png
---

In this post, we are going to build a email verification system.

Look, we've got a problem with our authentication system. When someone registers with `sam@gmail.com`, there's literally zero proof they actually own that email. They could be:
- Using someone else's email to impersonate them
- Typing in a completely fake email that doesn't even exist
- Testing which emails are already in our system by watching for "email already exists" errors

And here's another issue, if a user forgets their password, they're permanently locked out. No recovery option. That's not great. We will handle this in the next article as this article is getting too long.

You can find all the code here --> https://github.com/0xshadow-dev/realworld-axum-api

## OurApproach
We're building 2 types of tokens:
**Email Verification Token:**
- Gets created automatically when someone signs up
- Valid for 24 hours
- Single-use only (we delete it once it's used)

**Password Reset Token:**(Next article)
- Created when a user clicks "Forgot password"
- Valid for only 1 hour (tighter security window)
- Also single-use

But before we dive into building these features, we need to refactor our code first. Trust me, it'll make everything easier.

## Refactoring to Repository Traits
Right now, our `UserRepository` is just a struct that directly uses SQLx. Here's the problem with that:

```rust
pub struct UserRepository {
    db: PgPool,
}
```

This code creates three headaches:
**Problem 1: Testing becomes a nightmare**
Every single test needs a real PostgreSQL database. That means:
- Starting up PostgreSQL
- Running migrations
- Cleaning up test data afterwards
- Waiting forever because database I/O is slow

We can't write a quick unit test that runs in milliseconds. Everything needs the full database setup.

**Problem 2: We're stuck with SQLx**
Want to try MongoDB? Add Redis caching? Use an in-memory database for local dev? Too bad. We'd have to go through every handler and modify how it uses `UserRepository`. That's a ton of changes across your entire codebase.

**Problem 3: Zero flexibility**
We might want different implementations for different environments:
- Production: Real PostgreSQL with connection pooling
- Testing: Mock repository that returns fake data instantly
- Development: In-memory database that's blazing fast

With concrete structs, we can't swap these out.
### Why Traits Fix Everything
A trait defines _what_ a type can do, without caring _how_ it does it. Think of it as a contract.

Here's a simple example:
```rust
// The contract: all animals must be able to make a sound
trait Animal {
    fn make_sound(&self) -> String;
}

// Dog implements it one way
struct Dog;
impl Animal for Dog {
    fn make_sound(&self) -> String {
        "Woof!".to_string()
    }
}

// Cat implements it differently
struct Cat;
impl Animal for Cat {
    fn make_sound(&self) -> String {
        "Meow!".to_string()
    }
}

// This function works with ANY animal
fn pet_animal(animal: &dyn Animal) {
    println!("{}", animal.make_sound());
}

pet_animal(&Dog);  // Woof!
pet_animal(&Cat);  // Meow!
```

See how `pet_animal` doesn't care if it gets a Dog or Cat? It just knows it can call `make_sound()`.

Ok, lets start refactoring our codebase.
### Add Dependencies
First, update your `Cargo.toml`. The `[lib]` and `[[bin]]` sections are here because they tell Cargo that you have both a library and a binary:

```toml
[package]
name = "realworld-axum-api"
version = "0.1.0"
edition = "2021"

[lib]
name = "realworld_axum_api"
path = "src/lib.rs"

[[bin]]
name = "realworld-axum-api"
path = "src/main.rs"

[dependencies]
# Core web framework
axum = { version = "0.8", features = ["macros"] }
tokio = { version = "1.0", features = ["full"] }

# Database
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "postgres", "uuid", "chrono", "migrate"] }

# Serialization
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# Validation
validator = { version = "0.18", features = ["derive"] }

# UUID and time
uuid = { version = "1.0", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }

# Configuration
dotenvy = "0.15"

# Auth
bcrypt = "0.15"
jsonwebtoken = "9.0"
async-trait = "0.1"

# Email sending (we'll use this later)
lettre = { version = "0.11", features = ["tokio1-native-tls", "builder", "hostname"] }
```

Without the `[lib]` and `[[bin]]` split, you'll get confusing import errors later. This setup lets `main.rs` import from your library code cleanly.

Why `async-trait`? Because Rust doesn't natively support async methods in traits yet. The crate handles all the complex transformations behind the scenes.

### Create the UserRepositoryTrait
Now, lets create the user repository trait that we were talking about.
Create a new file `src/repositories/traits.rs`:

```rust
use async_trait::async_trait;
use sqlx::Error as SqlxError;
use uuid::Uuid;
use crate::models::User;

#[async_trait]
pub trait UserRepositoryTrait: Send + Sync {
    async fn create(
        &self,
        username: &str,
        email: &str,
        password_hash: &str,
    ) -> Result<User, SqlxError>;

    async fn find_by_id(&self, user_id: Uuid) -> Result<Option<User>, SqlxError>;

    async fn find_by_email(&self, email: &str) -> Result<Option<User>, SqlxError>;

    async fn find_by_username(&self, username: &str) -> Result<Option<User>, SqlxError>;

    async fn update(
        &self,
        id: Uuid,
        username: Option<&str>,
        email: Option<&str>,
        bio: Option<&str>,
        image: Option<&str>,
    ) -> Result<Option<User>, SqlxError>;
}
```

Let me explain what's happening here:

**The `#[async_trait]` macro** - This is what lets us write async methods in traits. Without it, the compiler would throw a fit.

**`: Send + Sync` bounds** - These are important for Axum:

`Send` means the repository can be moved between threads. Let me show you a dummy code. I think that'll help you understand this more clearly:
```rust
// Thread 1 creates it
let repo = UserRepository::new(db);

// Thread 2 can take ownership
thread::spawn(move || {
    repo.find_by_email("test@example.com");
});
```

`Sync` means multiple threads can share references to it. Let me show you a dummy code for this too:
```rust
// Multiple threads accessing simultaneously
let repo = Arc::new(UserRepository::new(db));

let repo1 = Arc::clone(&repo);
thread::spawn(move || {
    repo1.find_by_email("test@example.com");
});

let repo2 = Arc::clone(&repo);
thread::spawn(move || {
    repo2.find_by_email("other@example.com");
});
```

Axum runs handlers concurrently, so we need both.

**Why `Result<Option<User>, SqlxError>`?**

This signature lets us distinguish three different outcomes:

```rust
match repo.find_by_id(user_id).await {
    Ok(Some(user)) => {
        // Found the user, all good
    }
    Ok(None) => {
        // User doesn't exist - not an error, just doesn't exist
    }
    Err(e) => {
        // Something went wrong - database connection failed, etc.
    }
}
```

If we just used `Result<User, SqlxError>`, we couldn't tell the difference between "user not found" and "database exploded".

> If you are coming from java background, you might have used interfaces in this way for your repository pattern.


### Implement the Trait

Now let's make our concrete `UserRepository` implement this trait. Update `src/repositories/user_repository.rs`:

```rust
use super::traits::UserRepositoryTrait;
use crate::models::User;
use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Clone)]
pub struct UserRepository {
    db: PgPool,
}

impl UserRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }
}

#[async_trait]
impl UserRepositoryTrait for UserRepository {
    async fn create(
        &self,
        username: &str,
        email: &str,
        password_hash: &str,
    ) -> Result<User, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (username, email, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, username, email, password_hash, bio, image,
                      created_at, updated_at
            "#,
        )
        .bind(username)
        .bind(email)
        .bind(password_hash)
        .fetch_one(&self.db)
        .await?;

        Ok(user)
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, username, email, password_hash, bio, image,
                   created_at, updated_at
            FROM users
            WHERE id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }

    async fn find_by_email(&self, email: &str) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, username, email, password_hash, bio, image,
                   created_at, updated_at
            FROM users
            WHERE email = $1
            "#,
        )
        .bind(email)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }

    async fn find_by_username(&self, username: &str) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, username, email, password_hash, bio, image,
                   created_at, updated_at
            FROM users
            WHERE username = $1
            "#,
        )
        .bind(username)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }

    async fn update(
        &self,
        id: Uuid,
        username: Option<&str>,
        email: Option<&str>,
        bio: Option<&str>,
        image: Option<&str>,
    ) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            UPDATE users
            SET username = COALESCE($2, username),
                email = COALESCE($3, email),
                bio = COALESCE($4, bio),
                image = COALESCE($5, image)
            WHERE id = $1
            RETURNING id, username, email, password_hash, bio, image,
                      created_at, updated_at
            "#,
        )
        .bind(id)
        .bind(username)
        .bind(email)
        .bind(bio)
        .bind(image)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }
}
```

The implementation is identical to what we had before. We're just wrapping it in a trait implementation block with the `#[async_trait]` macro.

### Export Everything

Update `src/repositories/mod.rs`:
```rust
mod traits;
mod user_repository;

pub use traits::UserRepositoryTrait;
pub use user_repository::UserRepository;
```

This lets other modules import both the trait and the concrete implementation. We have done this a lot in our previous articles too.

### Update AppState
This is where everything comes together. Update `src/state.rs`:

```rust
use std::sync::Arc;
use crate::repositories::{UserRepository, UserRepositoryTrait};
use axum::extract::FromRef;
use sqlx::PgPool;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub db: PgPool,
    pub user_repository: Arc<dyn UserRepositoryTrait>,
}

impl AppState {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let db = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations").run(&db).await?;

        let user_repository: Arc<dyn UserRepositoryTrait> =
            Arc::new(UserRepository::new(db.clone()));

        Ok(Self {
            db,
            user_repository,
        })
    }
}
```

Look at the type change that we did:

```rust
// Before
pub user_repository: UserRepository,

// After
pub user_repository: Arc<dyn UserRepositoryTrait>,
```

**`dyn UserRepositoryTrait`** - The `dyn` keyword means "dynamic dispatch". At runtime, this could be `UserRepository`, `MockUserRepository`, `CachedUserRepository`, or any type that implements the trait. The compiler doesn't need to know which specific type it is at compile time.

**`Arc<dyn UserRepositoryTrait>`** - `Arc` stands for "Atomic Reference Counted". It's a smart pointer that lets multiple owners share the same data

Axum clones `AppState` for every request, but with `Arc`, all those clones point to the same repository instance in memory. We're not creating multiple database connections, we're sharing one.

### Update `main.rs`

Our `main.rs` should import from the library crate, not use `crate::`:

```rust
use axum::{
    routing::{get, post},
    Router,
};
use std::env;

// Import from the library crate
use realworld_axum_api::{
    handlers::{register, login, current_user, health_check},
    state::AppState,
};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let database_url =
        env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    let app_state = AppState::new(&database_url)
        .await
        .expect("Failed to connect to database");

    println!("Connected to database successfully!");

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/api/users", post(register))
        .route("/api/users/login", post(login))
        .route("/api/user", get(current_user))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://localhost:3000");

    axum::serve(listener, app).await.unwrap();
}
```

Notice `realworld_axum_api::` not `crate::`. This is because `main.rs` is our binary executable, and it needs to import from our library code.

Also update `src/handlers/mod.rs`:
```rust
pub mod auth;
pub mod health;

pub use auth::{register, login, current_user};
pub use health::health_check;
```

Now test it:

```bash
cargo build
cargo run
```

Everything should work exactly like before. We haven't changed any behavior, just restructured the code to be more flexible and testable. Now we're ready to build the email verification system on top of this solid foundation.

## Email Verification System
Alright, now that we've got our repository pattern sorted out, let's build the actual email verification system. This is where things get interesting.

### Create Database Migrations

First, we need places to store our verification tokens and track which users have verified their emails.

#### Migration 1 - Email Verification Tokens Table
Run the following command to create a migration file:
```bash
sqlx migrate add create_email_verification_tokens
```
Create `migrations/0002_create_email_verification_tokens.sql`:

```sql
-- Migration 0002: Create email verification tokens table

CREATE TABLE email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
CREATE INDEX idx_email_verification_tokens_expires_at ON email_verification_tokens(expires_at);
```

Let me explain what's happening here:

**`user_id UUID NOT NULL REFERENCES users(id)`** - This creates a foreign key relationship. Each token belongs to exactly one user.

**`ON DELETE CASCADE`** - This is crucial. If we delete a user, PostgreSQL automatically deletes all their tokens. No orphaned data floating around in our database.

**`token VARCHAR(255) UNIQUE NOT NULL`** - The actual verification token. It must be unique (no two users can have the same token) and can't be null.

**`expires_at TIMESTAMP WITH TIME ZONE NOT NULL`** - When the token becomes invalid. We'll set this to 24 hours from creation.

**The indexes** - These make queries blazing fast. When a user clicks a verification link, we search by token. Without an index, PostgreSQL would scan the entire table row by row. With an index, it's nearly instant even with millions of tokens.

#### Migration 2 - Add Email Verified Field to Users
Run the following command to create another migration file:
```bash
sqlx migrate add add_email_verified_to_users
```

Create `migrations/0003_add_email_verified_to_users.sql`:

```sql
-- Migration 003: Add email_verified field to users

ALTER TABLE users
ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for filtering verified users
CREATE INDEX idx_users_email_verified ON users(email_verified);
```

**`DEFAULT FALSE`** - When users register, they start unverified. Makes sense, right? They haven't clicked the link yet.

The index helps when we want to query things like "show me all verified users" or check if a user is verified before letting them do something.

Now run the migrations:

```bash
sqlx migrate run
```

You should see a successful message on your terminal. If that's not printed for some reason, please check your database, you should see a new table and the updated users table.
### Update the User Model

Now that we've added `email_verified` to the database, we need to update our Rust model to match.

Open `src/models/user.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub bio: Option<String>,
    pub image: Option<String>,
    pub email_verified: bool,  // NEW FIELD
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

Just added `email_verified: bool`. SQLx will automatically map this from the database column.

**Now here's the critical part** - remember all those SQL queries in our `UserRepository`? We need to update them to include `email_verified` in every RETURNING and SELECT clause:

Update `src/repositories/user_repository.rs`:

```rust
// In the create method
RETURNING id, username, email, password_hash, bio, image,
          email_verified, created_at, updated_at  // Added email_verified

// In all the find methods
SELECT id, username, email, password_hash, bio, image,
       email_verified, created_at, updated_at  // Added email_verified

// In the update method
RETURNING id, username, email, password_hash, bio, image,
          email_verified, created_at, updated_at  // Added email_verified
```

If you forget to add `email_verified` even in ONE query, SQLx will hang indefinitely because it can't deserialize the `User`struct. The database returns a column that the struct expects, but your query didn't ask for it. This causes a mismatch and everything breaks. Trust me, I've debugged this issue too many times.

> If you are confused where to update, then please take a look at the github link that I've shared at the top of the page, you can reference that or just copy paste the entire file.
### Create Email Verification Token Model

Now let's create the Rust model for our email verification tokens. Just like we did for our user model.

Create `src/models/email_verification_token.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EmailVerificationToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl EmailVerificationToken {
    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }
}
```

The `is_expired()` helper method makes our code cleaner. Instead of writing `Utc::now() > token.expires_at`everywhere, we just call `token.is_expired()`. Simple and readable.

Update `src/models/mod.rs`:
```rust
pub mod user;
pub mod email_verification_token;

pub use user::User;
pub use email_verification_token::EmailVerificationToken;
```

### Create Token Generator Utility

We need a way to generate random, secure tokens. Let's use UUIDs for this. To do this, lets write a helper or utility function

Create `src/utils/mod.rs`:
```rust
pub mod token_generator;

pub use token_generator::generate_verification_token;
```

Create `src/utils/token_generator.rs`:
```rust
use uuid::Uuid;

pub fn generate_verification_token() -> String {
    // Generate a random UUID and convert to string without hyphens
    // Example: "550e8400e29b41d4a716446655440000"
    Uuid::new_v4().simple().to_string()
}
```

Why UUIDs?
Its, random, extremely unlikely to collide like astronomical odds. The `simple()` removes the hyphens from the ids, hence making it cleaner.

Update `src/lib.rs` to include the new module:

```rust
pub mod auth;
pub mod handlers;
pub mod models;
pub mod repositories;
pub mod schemas;
pub mod state;
pub mod utils;  // NEW
```

### Create Email Verification Repository Trait
Just like we did for users, let's create a trait for email verification operations.

Open `src/repositories/traits.rs` and add this trait (make sure to update the imports at the top):

```rust
use async_trait::async_trait;
use sqlx::Error as SqlxError;
use uuid::Uuid;
use crate::models::{User, EmailVerificationToken};  // Updated import

// ... existing UserRepositoryTrait ...

#[async_trait]
pub trait EmailVerificationRepositoryTrait: Send + Sync {
    async fn create_token(
        &self,
        user_id: Uuid,
        token: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<EmailVerificationToken, SqlxError>;

    async fn find_by_token(&self, token: &str) -> Result<Option<EmailVerificationToken>, SqlxError>;

    async fn delete_token(&self, token: &str) -> Result<(), SqlxError>;

    async fn verify_user_email(&self, user_id: Uuid) -> Result<(), SqlxError>;
}
```

What each method does:
- **`create_token`** - Inserts a new verification token into the database
- **`find_by_token`** - Looks up a token (when user clicks the verification link)
- **`delete_token`** - Removes a token after it's used (single-use tokens)
- **`verify_user_email`** - Marks a user as verified in the users table

Nothing fancy, simple CRUD operations that we have already seen with user trait too.

> In future, we might have different files for different traits but for now, lets keep them in a single file. That's how we will understand how to incrementally manage codebase changes.
### Implement the Email Verification Repository
Now, its time to implement the concrete Email repository.
Create `src/repositories/email_verification_repository.rs`:

```rust
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::traits::EmailVerificationRepositoryTrait;
use crate::models::EmailVerificationToken;

#[derive(Clone)]
pub struct EmailVerificationRepository {
    db: PgPool,
}

impl EmailVerificationRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }
}

#[async_trait]
impl EmailVerificationRepositoryTrait for EmailVerificationRepository {
    async fn create_token(
        &self,
        user_id: Uuid,
        token: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<EmailVerificationToken, sqlx::Error> {
        let verification_token = sqlx::query_as::<_, EmailVerificationToken>(
            r#"
            INSERT INTO email_verification_tokens (user_id, token, expires_at)
            VALUES ($1, $2, $3)
            RETURNING id, user_id, token, expires_at, created_at
            "#,
        )
        .bind(user_id)
        .bind(token)
        .bind(expires_at)
        .fetch_one(&self.db)
        .await?;

        Ok(verification_token)
    }

    async fn find_by_token(&self, token: &str) -> Result<Option<EmailVerificationToken>, sqlx::Error> {
        let verification_token = sqlx::query_as::<_, EmailVerificationToken>(
            r#"
            SELECT id, user_id, token, expires_at, created_at
            FROM email_verification_tokens
            WHERE token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.db)
        .await?;

        Ok(verification_token)
    }

    async fn delete_token(&self, token: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            DELETE FROM email_verification_tokens
            WHERE token = $1
            "#,
        )
        .bind(token)
        .execute(&self.db)
        .await?;

        Ok(())
    }

    async fn verify_user_email(&self, user_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE users
            SET email_verified = TRUE
            WHERE id = $1
            "#,
        )
        .bind(user_id)
        .execute(&self.db)
        .await?;

        Ok(())
    }
}
```

Nothing fancy here. Standard CRUD operations we've done before. The pattern should look familiar by now.

Update `src/repositories/mod.rs`:

```rust
mod traits;
mod user_repository;
mod email_verification_repository;  // NEW

pub use traits::{UserRepositoryTrait, EmailVerificationRepositoryTrait};  // Updated
pub use user_repository::UserRepository;
pub use email_verification_repository::EmailVerificationRepository;  // NEW
```

### Update AppState
Our AppState needs to hold the email verification repository so handlers can use it. Just like user repository.

Open `src/state.rs` and update:

```rust
use std::sync::Arc;
use crate::repositories::{
    UserRepository,
    UserRepositoryTrait,
    EmailVerificationRepository,
    EmailVerificationRepositoryTrait,
};
use axum::extract::FromRef;
use sqlx::PgPool;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub db: PgPool,
    pub user_repository: Arc<dyn UserRepositoryTrait>,
    pub email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait>,  // NEW
}

impl AppState {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let db = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations").run(&db).await?;

        let user_repository: Arc<dyn UserRepositoryTrait> =
            Arc::new(UserRepository::new(db.clone()));

        let email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait> =
            Arc::new(EmailVerificationRepository::new(db.clone()));

        Ok(Self {
            db,
            user_repository,
            email_verification_repository,
        })
    }
}
```

Same pattern as before. Create the repository, wrap it in an `Arc` for shared access across threads.

Now test everything compiles:

```bash
cargo build
```

If it builds successfully, we've got our database infrastructure ready. In the next section, we'll set up the actual email sending with Mailtrap and update our handlers to use all this new code.

## Email Sending with Mailtrap

Alright, we've got the database infrastructure ready. Now let's hook up actual email sending so users can verify their accounts.

### Set Up Mailtrap Account

Mailtrap is a fake SMTP server that's perfect for development. It catches all your emails so you can test without spamming real inboxes.

> You can use the setup with production SMTP server as well, but for development stage, we can go with mailtrap as it's very easy to setup and has a generous free tier and we can use fake emails like test@test.com or something else and test our email confirmation feature without requiring original mail IDs.

#### Step 1: Sign up at [mailtrap.io](https://mailtrap.io/
The free tier is more than enough for what we need.

#### Step 2: Create an inbox
- After signing in, go to Sandbox and create a new project
- Name it something like "Axum API Testing"
#### Step 3: Get your SMTP credentials

- Click on your inbox or project.
- Go to "SMTP Settings"
- You'll see something like:
    - **Host**: `sandbox.smtp.mailtrap.io`
    - **Port**: `2525` or `587`
    - **Username**: Something like `7a3b8c9d1e2f34`
    - **Password**: Something like `a1b2c3d4e5f6g7`

**Step 4: Update your `.env` file**

```env
DATABASE_URL=postgresql://username:password@localhost:5432/database_name
JWT_SECRET=your-super-secret-jwt-key-change-this

# Mailtrap SMTP Configuration
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=587
SMTP_USERNAME=your_mailtrap_username_here
SMTP_PASSWORD=your_mailtrap_password_here
SMTP_FROM_EMAIL=noreply@yourapp.com
SMTP_FROM_NAME=YourApp

# Base URL for email links
BASE_URL=http://localhost:3000
```

Replace `SMTP_USERNAME` and `SMTP_PASSWORD` with your actual Mailtrap credentials.

Why port 587? It uses STARTTLS which is more compatible with modern SMTP servers than plain port 2525.

### Create Email Service
Now, lets create the email service that we will use while registering a user.

> We could have kept all the following code inside the register handler but its a good practice to create a service for every external service that we interact with be it mailing service, or payment service or something else.

Create `src/services/mod.rs`:

```rust
pub mod email_service;

pub use email_service::EmailService;
```

Alright, let me walk you through the entire `EmailService` code line by line.

## The Email Service Structure

```rust
pub struct EmailService {
    mailer: SmtpTransport,
    from_email: Mailbox,
}
```

This struct holds two things:

**`mailer: SmtpTransport`** - This is your actual SMTP connection. Think of it like a persistent phone line to your email server. Once you establish it, you can keep using it to send multiple emails without reconnecting each time.

**`from_email: Mailbox`** - This stores who the email is "from". We parse it once during initialization so we don't have to rebuild it for every email we send.

## The Initialization: `new()`

```rust
pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
    println!("Initializing email service...");
```

We return a `Result` because setting up SMTP can fail (bad credentials, network issues, etc.). The `Box<dyn std::error::Error>` is a catch-all error type - we're saying "this could fail in various ways."

```rust
    let smtp_host = env::var("SMTP_HOST").expect("SMTP_HOST must be set");
    let smtp_port: u16 = env::var("SMTP_PORT")
        .expect("SMTP_PORT must be set")
        .parse()
        .expect("SMTP_PORT must be a valid number");
    let smtp_username = env::var("SMTP_USERNAME").expect("SMTP_USERNAME must be set");
    let smtp_password = env::var("SMTP_PASSWORD").expect("SMTP_PASSWORD must be set");
```

We're loading configuration from environment variables. The `.expect()` calls will crash the app if these aren't set - which is exactly what we want. If SMTP isn't configured, the app shouldn't start at all.

The port gets parsed from a string to `u16` (unsigned 16-bit integer) because ports are numbers from 0-65535.

```rust
    let from_email_str = env::var("SMTP_FROM_EMAIL").expect("SMTP_FROM_EMAIL must be set");
    let from_name = env::var("SMTP_FROM_NAME").expect("SMTP_FROM_NAME must be set");
```

We need both the email address (`noreply@yourapp.com`) and a display name (`YourApp`). This is what shows up in the recipient's inbox as the sender.

```rust
    let credentials = Credentials::new(smtp_username, smtp_password);
```

Bundle the username and password into a `Credentials` struct that lettre understands.

```rust
    let mailer = SmtpTransport::starttls_relay(&smtp_host)?
        .port(smtp_port)
        .credentials(credentials)
        .build();
```

This is the core SMTP setup. Let me break it down:

**`SmtpTransport::starttls_relay(&smtp_host)?`** - Creates a transport that uses STARTTLS. This means:

1. Connect to the server over plain TCP
2. Upgrade the connection to TLS (encrypted)

STARTTLS is more compatible than trying to connect with TLS from the start. The `?` at the end means "if this fails, return the error early."

**`.port(smtp_port)`** - Tell it which port to use (587 or 2525 for Mailtrap).

**`.credentials(credentials)`** - Attach our login credentials.

**`.build()`** - Finalize the configuration and create the actual transport object.

```rust
    let from_email = format!("{} <{}>", from_name, from_email_str)
        .parse()
        .expect("Invalid from email format");
```

We're creating a formatted email address like `"YourApp <noreply@yourapp.com>"`. The `format!` macro builds the string, then `.parse()` converts it into a `Mailbox` type that lettre understands. If the format is invalid, we crash with the expect message.

```rust
    Ok(Self { mailer, from_email })
}
```

Return our initialized service wrapped in `Ok`.

## The Email Sending Method

```rust
pub async fn send_verification_email(
    &self,
    to_email: &str,
    username: &str,
    verification_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
```

**Why `async`?** - Email sending involves network I/O. Making it async means other operations can happen while we wait for the SMTP server to respond.

**Parameters:**

- `&self` - We need access to `self.mailer` and `self.from_email`
- `to_email` - Who we're sending to
- `username` - For personalization in the email
- `verification_token` - The token they need to verify

**Returns `Result<(), ...>`** - Either succeeds with nothing (`()`) or returns an error.

```rust
    let base_url = env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let verification_link = format!("{}/api/auth/verify-email?token={}", base_url, verification_token);
```

Build the verification URL. If `BASE_URL` isn't set in environment variables, default to localhost. In production, this would be your actual domain like `https://yourapp.com`.

```rust
    let html_body = format!(
        r#"
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                // ... more styles ...
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Welcome to YourApp!</h1>
                </div>
                <div class="content">
                    <h2>Hi {}!</h2>
                    <p>Thanks for signing up! We're excited to have you on board.</p>
                    <p>Please verify your email address by clicking the button below:</p>
                    <div style="text-align: center;">
                        <a href="{}" class="button">Verify Email Address</a>
                    </div>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="background-color: #eee; padding: 10px; word-break: break-all;">{}</p>
                    <p><strong>This link will expire in 24 hours.</strong></p>
                    <p>If you didn't create an account, please ignore this email.</p>
                </div>
                <div class="footer">
                    <p>© 2024 YourApp. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
        "#,
        username, verification_link, verification_link
    );
```

This is the HTML email template. Let me explain this:

**`r#"..."#`** - Raw string literal. This means we don't have to escape quotes inside. Super useful for HTML.

**Double braces `{{`** - In format strings, `{` is special (for placeholders). To get a literal `{` in CSS, we write `{{`. So `{{ font-family: Arial }}` becomes `{ font-family: Arial }` in the output.

**Three `{}` placeholders at the end** - These get replaced by `username, verification_link, verification_link` (we use the link twice - once in the button, once as plain text).

**Why inline styles?** - Email clients (Gmail, Outlook) are terrible with external CSS. Inline styles are the only reliable way to make emails look good across all clients.

**Why provide both a button and plain text link?** - Some email clients block links in buttons. The plain text link is a fallback.

```rust
    let email = Message::builder()
        .from(self.from_email.clone())
        .to(to_email.parse()?)
        .subject("Verify Your Email Address")
        .header(ContentType::TEXT_HTML)
        .body(html_body)?;
```

Build the email message:

**`.from(self.from_email.clone())`** - Use our pre-configured "from" address. We clone it because `Message::builder()` takes ownership.

**`.to(to_email.parse()?)`** - Parse the recipient's email string into a proper email address. The `?` means "if parsing fails, return the error."

**`.subject(...)`** - The email subject line.

**`.header(ContentType::TEXT_HTML)`** - Tell email clients this is HTML, not plain text.

**`.body(html_body)?`** - Attach our HTML. The `?` means "if there's an error building the message, return early."

```rust
    self.mailer.send(&email)?;
```

Actually send the email using our SMTP connection. The `?` handles any network errors.

```rust
    println!("Verification email sent to {}", to_email);
    println!("Verification link: {}", verification_link);

    Ok(())
}
```

Log success to the console (helpful during development) and return `Ok(())` to indicate success.


Update `src/lib.rs`:

```rust
pub mod auth;
pub mod handlers;
pub mod models;
pub mod repositories;
pub mod schemas;
pub mod state;
pub mod services;  // NEW
pub mod utils;
```

### Update AppState with Email Service

Open `src/state.rs` and add the email service:

```rust
use std::sync::Arc;
use crate::repositories::{
    UserRepository,
    UserRepositoryTrait,
    EmailVerificationRepository,
    EmailVerificationRepositoryTrait,
};
use crate::services::EmailService;  // NEW
use axum::extract::FromRef;
use sqlx::PgPool;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub db: PgPool,
    pub user_repository: Arc<dyn UserRepositoryTrait>,
    pub email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait>,
    pub email_service: Arc<EmailService>,  // NEW
}

impl AppState {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let db = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations").run(&db).await?;

        let user_repository: Arc<dyn UserRepositoryTrait> =
            Arc::new(UserRepository::new(db.clone()));

        let email_verification_repository: Arc<dyn EmailVerificationRepositoryTrait> =
            Arc::new(EmailVerificationRepository::new(db.clone()));

        let email_service = Arc::new(
            EmailService::new().expect("Failed to initialize email service")
        );

        Ok(Self {
            db,
            user_repository,
            email_verification_repository,
            email_service,
        })
    }
}
```

We're wrapping the email service in `Arc` just like our repositories. This way all handlers share the same SMTP connection pool.

### Update Registration Handler

Now let's add the email sending to our registration flow. Open `src/handlers/auth.rs` and update the register function:

```rust
use crate::{
    auth::{
        jwt::generate_token,
        password::hash_password,
    },
    schemas::auth_schemas::*,
    state::AppState,
    utils::generate_verification_token,  // NEW
};
use axum::{extract::State, http::StatusCode, Json};
use chrono::{Duration, Utc};  // NEW
use validator::Validate;

pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterUserRequest>,
) -> Result<Json<UserResponse>, StatusCode> {
    payload
        .user
        .validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    if state
        .user_repository
        .find_by_email(&payload.user.email)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Err(StatusCode::CONFLICT);
    }

    if state
        .user_repository
        .find_by_username(&payload.user.username)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Err(StatusCode::CONFLICT);
    }

    let password_hash =
        hash_password(&payload.user.password).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user = state
        .user_repository
        .create(&payload.user.username, &payload.user.email, &password_hash)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // NEW: Generate verification token
    let verification_token = generate_verification_token();
    let expires_at = Utc::now() + Duration::hours(24);

    // NEW: Save token to database
    state
        .email_verification_repository
        .create_token(user.id, &verification_token, expires_at)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // NEW: Send verification email
    state
        .email_service
        .send_verification_email(&user.email, &user.username, &verification_token)
        .await
        .map_err(|e| {
            eprintln!("Failed to send verification email: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let jwt_secret = std::env::var("JWT_SECRET").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token =
        generate_token(&user.id, &jwt_secret).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user_data = UserData::from_user_with_token(user, token);
    let response = UserResponse { user: user_data };

    Ok(Json(response))
}
```

Here's what we added:

1. **Generate a token** - Using our UUID-based generator
2. **Set expiration** - 24 hours from now using chrono's `Duration`
3. **Save to database** - Store the token so we can verify it later
4. **Send email** - Fire off the verification email

Notice we're using `eprintln!` to log errors. If email sending fails, we print the error but still return 500. In future, we will set up a better centralized logging system for all these loggings.

### Add Email Verification Endpoint
Its time to create the endpoint for email verification. It'll be used in the verification link that we will send to the user.
Now we need an endpoint where users actually verify their email. Add this function to `src/handlers/auth.rs`:

```rust
pub async fn verify_email(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // Extract token from query params
    let token = params
        .get("token")
        .ok_or(StatusCode::BAD_REQUEST)?;

    // Look up the token in database
    let verification_token = state
        .email_verification_repository
        .find_by_token(token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Check if expired
    if verification_token.is_expired() {
        // Clean up expired token
        state
            .email_verification_repository
            .delete_token(token)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        return Err(StatusCode::GONE);
    }

    // Mark user as verified
    state
        .email_verification_repository
        .verify_user_email(verification_token.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Delete token (single-use)
    state
        .email_verification_repository
        .delete_token(token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "message": "Email verified successfully!"
    })))
}
```

The flow is straightforward:

1. **Extract token** from query parameters
2. **Look it up** in the database
3. **Check expiration** - if expired, delete it and return 410 GONE
4. **Verify user** - update the user record
5. **Delete token** - single-use only, no reusing tokens

We return 410 GONE for expired tokens instead of 404 because the token _did_ exist, it's just no longer valid. Semantic HTTP codes matter.

### Update User Response Schema

We need to include the `email_verified` status when we return user data. Open `src/schemas/auth_schemas.rs`:

```rust
#[derive(Debug, Serialize)]
pub struct UserData {
    pub email: String,
    pub token: String,
    pub username: String,
    pub bio: String,
    pub image: Option<String>,
    pub email_verified: bool,  // NEW FIELD
}

impl UserData {
    pub fn from_user_with_token(user: crate::models::User, token: String) -> Self {
        Self {
            email: user.email,
            token,
            username: user.username,
            bio: user.bio.unwrap_or_default(),
            image: user.image,
            email_verified: user.email_verified,  // NEW
        }
    }
}
```

Now when users register or get their profile, they'll see their verification status.

### Update Routes
Update `src/handlers/mod.rs`:
```rust
pub mod auth;
pub mod health;

pub use auth::{register, login, current_user, verify_email};  // Added verify_email
pub use health::health_check;
```

Update `src/main.rs`:
```rust
use realworld_axum_api::{
    handlers::{register, login, current_user, verify_email, health_check},  // Added verify_email
    state::AppState,
};

// In the router
let app = Router::new()
    .route("/health", get(health_check))
    .route("/api/users", post(register))
    .route("/api/users/login", post(login))
    .route("/api/user", get(current_user))
    .route("/api/auth/verify-email", get(verify_email))  // NEW ROUTE
    .with_state(app_state);
```
### Test It Out
Build and run:
```bash
cargo build
cargo run
```

Register a new user:
```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "user": {
      "username": "testuser",
      "email": "test@example.com",
      "password": "password123"
    }
  }'
```

You should see:
```json
{
  "user": {
    "email": "test@example.com",
    "token": "eyJ0eXAiOiJKV1QiLCJhbGc...",
    "username": "testuser",
    "bio": "",
    "image": null,
    "email_verified": false
  }
}
```

Check your terminal - you'll see the verification link printed. Also check your Mailtrap inbox for the nice HTML email.

I would say open the mail from your mailtrap inbox and click on that button to get verified. This way, you'll realise this is how email confirmation works for other websites or app too.

Click the link or use curl:

```bash
curl "http://localhost:3000/api/auth/verify-email?token=YOUR_TOKEN_HERE"
```

Response:

```json
{
  "message": "Email verified successfully!"
}
```

Now get the current user again:

```bash
curl http://localhost:3000/api/user \
  -H "Authorization: Token YOUR_JWT_TOKEN"
```

You'll see `email_verified: true`.

We've built a complete email verification system that's secure, tested, and ready for production. Users can't fake ownership of emails anymore, and we've got proof they control the addresses they register with.

## Conclusion
In this post, we understood a very interesting flow of email verification, we will use this same system for password reset functionality but as its too long already. I don't want to stretch it more. We will learn that in the next one. See you soon.
