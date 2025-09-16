---
title: "Axum Backend Series: Models, Migration, DTOs and Repository Pattern"
description: "Make design decisions for our user data storage, learn about migration, DTOs and repository pattern"
pubDatetime: 2025-09-16T00:30:00Z
tags: ["rust", "axum", "backend", "migration", "database", "sql", "design pattern"]
series: "Backend Engineering in Axum"
seriesOrder: 3
featured: true
ogImage: ../../../assets/images/axum-backend-engineering/migration/axum-migration-cover-image.png
---


In this post, we're going to make design decisions for our user data storage, learn about migration, DTOs, indexes and repository pattern. This post is a foundation to our next post where we will implement a JWT authentication, OAuth, 2FA, Magic Link auth system with email verification and forget password option too.
## Prerequisites
- Previous lessons completed
- PostgreSQL Docker container running

You can get all the code from this Github Repo --> https://github.com/0xshadow-dev/realworld-axum-api
## Database Schema Design and Migrations
Before doing anything, let's install the SQLx CLI tool to manage our database schema changes in a version-controlled way. I'll explain later what I mean by "version controlled way". For now, just run the command and install the SQLx CLI.

```bash
cargo install sqlx-cli
```

> Don't forget to start your PostgreSQL Docker container. To start the container run the following command in your terminal:
>
> ```bash
> docker start realworld-db
> ```

Before writing any code, let's first understand what user data we're going to store and use:
- We'll store email and password for authentication (Next article will cover complete authentication)
- We'll store username as their public display name
- Bio and Image will be optional fields
- We'll keep an ID for each user and track creation and update times

Now, there are some important design decisions we need to make before moving forward.
### Choosing Primary Key: Auto-increment vs UUID
For our primary key (the ID of each user), should we use auto-increment integers or UUIDs?

Auto-increment integers would give us IDs like 1, 2, 3, 4... which creates multiple problems:
- Anyone can guess user IDs and access profiles by incrementing numbers
- It reveals business metrics like total user count and growth rate
- If someone sees user ID 50,000, they know you have around 50,000 users

UUIDs give us random IDs like `f47ac10b-58cc-4372-a567-0e02b2c3d479`, due to which:
- It is nearly impossible to guess other user IDs
- No business intelligence leakage(metrics)
- We get better URLs like `GET /api/users/f47ac10b-58cc-4372-a567-0e02b2c3d479` instead of `GET /api/users/1`

We'll go with UUIDs for better security, scale and randomness of IDs.

### Choosing Text Field Types: VARCHAR vs TEXT
For text fields like username, email, password, and bio, should we use VARCHAR or TEXT?

VARCHAR(n) has a fixed maximum length and is optimized for short, predictable strings. The database can optimize storage and indexing better when it knows the maximum size.

TEXT has variable length with no specific limit, making it better for content of unknown or varying length, though with slightly more overhead.

We'll use VARCHAR for username, email, and password since these should have reasonable limits. For bio, we'll use TEXT since users might want to write longer descriptions without arbitrary limits.

### Timezone Handling for Timestamps
Should we store timestamps in local timezone or UTC?

When building applications that might have users across different time zones, we face a critical decision. Let's think of a scenario where you have users in New York, London, and Tokyo all creating accounts at the same moment.

Storing in local timezone creates chaos:
- User A creates account at "2024-12-01 10:00:00 EST"
- User B creates account at "2024-12-01 15:00:00 GMT"
- User C creates account at "2024-12-02 00:00:00 JST"

All three happened at the same moment, but sorting by creation time becomes impossible without complex timezone conversions. This conversion will happen on our Axum server, hence increasing computation usage.

Storing in UTC with timezone information solves this:
- All timestamps are stored as "2024-12-01 15:00:00 UTC"
- When displaying to users, we convert to their local timezone
- Sorting, filtering, and comparisons work perfectly
- We can always determine the exact moment something happened

We'll use `TIMESTAMP WITH TIME ZONE`, which PostgreSQL stores internally as UTC but includes timezone information for proper conversions.

## Understanding Database Migrations
Before we create our table, let's understand why we will use migrations instead of creating tables manually. Remember, I told you I'll explain what I mean by "version controlled way". Here you go, now we will learn what does that mean.
### What is a Database Migration?
A migration is a version-controlled way to make changes to your database schema. Think of it as Git for your database structure.

Imagine you're working with a team of developers. Without migrations, here's what typically happens:
#### The Problem Without Migrations:
Developer A creates a table manually in their local database:

```sql
CREATE TABLE users (id INTEGER, name VARCHAR(100));
```

Developer B doesn't know about this change and their code breaks. They manually create their own version:

```sql
CREATE TABLE users (id UUID, username VARCHAR(255), email VARCHAR(255));
```

Now you have two different database schemas. When you deploy to production, which version should you use? How do you ensure everyone has the same database structure?
#### The Solution With Migrations:
Instead of manual table creation, Developer A writes a migration file:

```sql
-- migrations/001_create_users.sql
CREATE TABLE users (
    id UUID PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL
);
```

This migration file is committed to Git. When Developer B pulls the code, they run:

```bash
sqlx migrate run
```

Now everyone has the exact same database structure. When you deploy to production, you run the same command, ensuring consistency across all environments.

I can list down the benefits but in general just remember the above example and you'll realise why it's better to go with migration instead of manual creation. Migration gives us a way to rollback like git does for commits in codebase. It is also consistent and easy to reproduce the entire schema structure, just run a single command and you'll have the same DB structure as your teammate.

For example, You later need to add a `bio` column. Instead of telling everyone "hey, run this SQL command," you create a new migration file. Everyone runs the migration command and that's it.

### Creating Our First Migration
Let's create the migration that will build our users table. We don't need to create a migrations directory manually; this command will do it for us:

```bash
sqlx migrate add create_users_table
```

This creates a `migrations/` folder in your project root. Inside, you'll see a SQL file named `create_users_table` with a timestamp prefix to maintain the order of migrations.


Your project structure now looks like:

```bash
your-project/
├── src/
├── Cargo.toml
├── .env
├── docker-compose.yml
└── migrations/
    └── 20241201120000_create_users_table.sql
```

### Writing the Users Table Migration
Now let's create our users table with all the fields we planned, implementing our design decisions:

```sql
-- Migration: Create users table
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    bio TEXT,
    image VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_created_at ON users(created_at);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

Let's break down each part of this migration:

**UUID Extension:**

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

This enables PostgreSQL's UUID generation functions. The `uuid_generate_v4()` function creates random UUIDs for our primary keys.

**Table Definition:**
```sql
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
```
Our primary key automatically generates a random UUID for each new user.

After this, we created the rest of the attributes like username, email, password, bio, image, created_at and updated_at. As I explained above, we will use varchar on everything except bio. We are using `NOT NULL` for username, email and password because we don't want to create users without a username or email or password. One more thing `UNIQUE` on username and email as there could be only 1 user with a single email ID and username. This is similar to how other websites work.

Now, let me explain a little bit about indexes as that's what we wrote after creating our table.
### Database Indexes for Query Performance
An index is like the index at the back of a book. Instead of reading every page to find a topic, you look it up in the index, which tells you exactly which page to go to.

Consider what happens during user login:
```sql
SELECT * FROM users WHERE email = 'john@example.com';
```

**Without an index on email -** The database must scan every single row in the users table. This is called a "table scan." If you have 100,000 users, the database checks all 100,000 rows to find John's email. As your user base grows, login becomes slower and slower.

**With an index on email -** The database maintains a sorted lookup table of all email addresses pointing to their rows. Finding John's email becomes almost instant, regardless of whether you have 1,000 or 1,000,000 users. (I'm not going in depth here as it'll stretch too long, I'll explain all about it later in a database engineering series).

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_created_at ON users(created_at);
```
We create indexes on columns we'll query frequently:
- `email` - Used during login authentication
- `username` - Used for profile lookups and mentions
- `created_at` - Used for analytics and user registration reports

> In a future article regarding performance, we will see how adding and removing indexes affects our overall performance. I think you'll love that.

Now, lets understand the final part of the sql code, that is the trigger.
### Automatic Timestamp Updates with Database Triggers
Making sure that the `updated_at` field is always current when user data changes is a common problem.

We want `updated_at` to automatically change whenever ANY field in a user's profile is modified. How do we guarantee this always happens?
There are 2 ways to handle this, one is update the `updated_at` field from the server whenever we're making an operation on the user's data and another way is to handle it directly from the DB
#### Option 1: Handle in Application Code

```rust
// In every update function, manually set timestamp
user.updated_at = Utc::now();
database.update_user(user).await?;
```

This approach has serious problems. It's easy to forget, especially as your application grows. Imagine you have multiple ways to update user data: the main API, an admin panel, mobile app endpoints, and data migration scripts. Each place needs to remember to update the timestamp. Miss it once, and your data becomes inconsistent.

#### Option 2: Handle at Database Level with Triggers
Database triggers automatically run code when certain events happen. It's like having a security guard who automatically locks the door whenever someone leaves the building - you don't have to remember, it just happens.

Here's how our trigger works:
##### The Function
```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';
```

This creates a reusable function that sets the `updated_at` field to the current timestamp. The `NEW` variable represents the row being updated, and we modify it before the update completes.

##### The Trigger
```sql
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
```

This trigger tells PostgreSQL: "Before any UPDATE happens on the users table, run our timestamp function for each affected row."

Ok, now lets understand the flow of how it works when an operation happens on a user's data.
#### How it works in practice:

```sql
-- Application updates user bio
UPDATE users SET bio = 'New bio' WHERE id = 'some-uuid';
```
1. Database sees UPDATE on users table
2. Trigger fires BEFORE the update
3. Function sets `updated_at = NOW()`
4. Original update proceeds with both `bio` AND `updated_at` changed

The best thing of this approach is that it's bulletproof. No matter how user data gets updated - through your API, admin panel, or future features you haven't built yet - the timestamp is always correct.

### Running the Migration
Now let's apply our migration to create the users table in our database:
```bash
sqlx migrate run
```

This is what you should get as output:
```
Applied 20241201120000/migrate create users table (42.8ms)
```
SQLx connects to our PostgreSQL database, checks which migrations have been applied, runs our new migration, and records its successful completion.

### Verifying the Migration
Let's verify our migration worked correctly by examining the database structure:
```bash
# Connect to PostgreSQL container
docker exec -it realworld-db psql -U realworld -d realworld_dev

# List all tables
\dt
```

You should see:
```bash
List of relations
 Schema |      Name       | Type  |     Owner
--------+-----------------+-------+----------------
 public | _sqlx_migrations| table | realworld_user
 public | users           | table | realworld_user
(2 rows)
```

Now check the users table structure:
```bash
\d users
```
You'll see our complete table definition with all fields, indexes, and the trigger we created. This confirms our migration successfully created exactly what we designed.

Now that we have our database foundation ready, we can move on to creating the Rust models and repository code that will interact with this users table.
## Creating the User Model
First, let's create our models directory and implement the User struct that represents our database table. Run the commands from your project root directory to create `models` directory and inside that 2 files
```bash
mkdir -p src/models
touch src/models/mod.rs
touch src/models/user.rs
```
### Understanding Rust Models
Before we write code, let's understand what a "model" represents in our application. A model is a Rust struct that mirrors our database table structure. It's the bridge between our SQL database and our Rust application. This is similar to other languages like Node.js, Python, and Java where you use classes to create models. In Go, we use structs too.

Think of it this way, our database stores data as rows and columns, but Rust works with structs and fields. The model translates between these two worlds, ensuring type safety and making our code easier to work with.

### Implementing the User Model
Let's start creating the User model in `src/models/user.rs`:

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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

Let me explain what we wrote. The derive attributes tell Rust to automatically implement certain traits for our struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
```

`Debug` lets us print the struct for debugging purposes, though sensitive fields like password_hash won't be visible in logs by default. `Clone` allows us to create copies of User instances when we need to pass them around our application. `Serialize` converts the struct to JSON for API responses, while `Deserialize` converts JSON back to the struct, though we'll rarely deserialize directly to User. The most important one is `FromRow`, which tells SQLx how to convert database rows into our Rust struct automatically.

Looking at our field definitions:
```rust
pub id: Uuid,                    // Maps to UUID in database
pub username: String,            // Maps to VARCHAR(255)
pub email: String,              // Maps to VARCHAR(255)
pub password_hash: String,      // Maps to VARCHAR(255) - notice we store hash, not password
pub bio: Option<String>,        // Maps to TEXT (nullable)
pub image: Option<String>,      // Maps to VARCHAR(255) (nullable)
pub created_at: DateTime<Utc>,  // Maps to TIMESTAMP WITH TIME ZONE
pub updated_at: DateTime<Utc>,  // Maps to TIMESTAMP WITH TIME ZONE
```

Every field except `bio` and `image` is compulsory, which is why `bio` and `image` are `Option<String>` because they can be set to null in our database and we need to handle this case in our Rust code.

You might notice that we're storing `password_hash` instead of `password`. This is a very common security practice. We never really store actual passwords in our database. Instead, we take the user's password, hash it using a certain algorithm (in the next article on authentication we will discuss secure algorithms and which one to use), then we store the hashed password in our database. Finally, when users log in, we hash their input and compare it to the stored hash.

### Setting Up the Models Module
Now, let's make our User struct available throughout the application. Update the `src/models/mod.rs`:

```rust
pub mod user;

pub use user::User;
```

This makes our User struct accessible from anywhere in our application by importing `use crate::models::User;`.

## Understanding Repository Pattern
If you're coming from Spring Boot, NestJS, or any other backend framework, this might seem familiar. Let me explain what this pattern is and why we're using it.
### What is the Repository Pattern?
Imagine your application needs to get user data. You could write database queries directly in your API handlers:

```rust
// Bad approach - database code mixed with API logic
async fn get_user_handler(id: Uuid, db: DatabasePool) -> Result<Json<User>, AppError> {
    let user = sqlx::query_as!(
        User,
        "SELECT * FROM users WHERE id = $1",
        id
    )
    .fetch_one(&db)
    .await?;

    Ok(Json(user))
}
```

This approach creates multiple problems. First, you have mixed responsibilities where your API handler now knows about SQL queries. This makes your code harder to test because you need a real database to test your handlers. You'll also end up with code duplication since every place that needs user data writes similar queries. Finally, it becomes hard to change because if you modify how users are stored, you need to update code everywhere.

The repository pattern solves these issues by creating a layer between your business logic and data storage.
```rust
// Good approach - repository handles database details
struct UserRepository {
    db: DatabasePool,
}

impl UserRepository {
    async fn find_by_id(&self, id: Uuid) -> Result<User, AppError> {
        // Database logic lives here
    }

    async fn find_by_email(&self, email: &str) -> Result<User, AppError> {
        // Database logic lives here
    }
}

// API handler stays clean and focused
async fn get_user_handler(id: Uuid, repo: UserRepository) -> Result<Json<User>, AppError> {
    let user = repo.find_by_id(id).await?;
    Ok(Json(user))
}
```

This gives us multiple benefits, let me explain. The repository has a single responsibility and only handles data access. Testing becomes easier because we can mock the repository for unit tests (We will start writing tests in some future article). Multiple handlers can reuse the same repository methods, and when we need to change database queries, we only update them in one place.

### Creating the Repository Directory
Run the commands in your terminal from the root directory of the project. It'll create a `repository` directory and 2 files inside that.

```bash
mkdir -p src/repositories
touch src/repositories/mod.rs
touch src/repositories/user_repository.rs
```

### Implementing the User Repository
Let's create our repository in `src/repositories/user_repository.rs`
```rust
use sqlx::{PgPool, Row};
use uuid::Uuid;
use crate::models::User;

#[derive(Clone)]
pub struct UserRepository {
    db: PgPool,
}

impl UserRepository {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }

    pub async fn create(&self, username: &str, email: &str, password_hash: &str) -> Result<User, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (username, email, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, username, email, password_hash, bio, image,
                      created_at, updated_at
            "#
        )
        .bind(username)
        .bind(email)
        .bind(password_hash)
        .fetch_one(&self.db)
        .await?;

        Ok(user)
    }

    pub async fn find_by_id(&self, id: Uuid) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, username, email, password_hash, bio, image,
                   created_at, updated_at
            FROM users
            WHERE id = $1
            "#
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }

    pub async fn find_by_email(&self, email: &str) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, username, email, password_hash, bio, image,
                   created_at, updated_at
            FROM users
            WHERE email = $1
            "#
        )
        .bind(email)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }

    pub async fn find_by_username(&self, username: &str) -> Result<Option<User>, sqlx::Error> {
        let user = sqlx::query_as::<_, User>(
            r#"
            SELECT id, username, email, password_hash, bio, image,
                   created_at, updated_at
            FROM users
            WHERE username = $1
            "#
        )
        .bind(username)
        .fetch_optional(&self.db)
        .await?;

        Ok(user)
    }

    pub async fn update(
        &self,
        id: Uuid,
        username: Option<&str>,
        email: Option<&str>,
        bio: Option<&str>,
        image: Option<&str>
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
            "#
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

Let me break down each function in our UserRepository implementation:

#### Constructor Function
```rust
pub fn new(db: PgPool) -> Self {
    Self { db }
}
```

This creates a new UserRepository instance. We pass in a PostgreSQL connection pool, which the repository stores and uses for all database operations. The connection pool manages multiple database connections efficiently, allowing concurrent requests to share connections.

#### Create Function
```rust
pub async fn create(&self, username: &str, email: &str, password_hash: &str) -> Result<User, sqlx::Error>
```

This function inserts a new user into the database. We use `&str` parameters instead of `String` to avoid unnecessary memory allocations. The `RETURNING` clause tells PostgreSQL to give us back the complete user record after insertion, including auto-generated fields like `id`, `created_at`, and `updated_at`. The `.bind()` method safely inserts our parameters, preventing SQL injection attacks.

#### Find Functions
All our find functions use `fetch_optional()` instead of `fetch_one()`. This returns `Option<User>`where `Some(user)` means we found a user, `None` means no user exists with that criteria, and `Err` means there was a database error. This approach makes the "not found" case explicit in our type system rather than throwing exceptions.

The `find_by_email` function is particularly important for login functionality, while `find_by_username` helps with profile lookups and checking username availability during registration.

#### Update Function
This function demonstrates partial updates using PostgreSQL's `COALESCE` function. If we pass `Some("new_value")`, it updates that field. If we pass `None`, it keeps the existing value. This lets users update just their bio without having to provide their username and email again.
### Setting up Repository Module

Let's update `src/repositories/mod.rs`:
```rust
pub mod user_repository;

pub use user_repository::UserRepository;
```

## Data Transfer Objects (DTOs)
DTOs are structs that define the shape of data coming into and going out of our API. They're different from our database models because API requests might not include all fields (like no ID when creating), API responses might exclude sensitive fields (like password_hash), and validation happens on DTOs(because this is the structure that we are using for request and response, the database model structure is used for storage and retrieval of data), not database models.

### Why Separate DTOs from Models?
Consider user registration. The client sends:
```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "secretpassword"
}
```

But our User model has fields the client doesn't provide. The `id` is generated by the database, `password_hash` comes from hashing the password, `bio` and `image` are optional and not provided, and `created_at` and `updated_at` are set by the database.

DTOs let us define exactly what data we expect from the client and what we send back.

### Creating Schema Directory
Again run the commands from root directory of your project.
```bash
mkdir -p src/schemas
touch src/schemas/mod.rs
touch src/schemas/user_schemas.rs
```

### Implementing User DTOs
Let's create `src/schemas/user_schemas.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct CreateUserRequest {
    #[validate(length(min = 3, max = 50, message = "Username must be between 3 and 50 characters"))]
    pub username: String,

    #[validate(email(message = "Invalid email format"))]
    pub email: String,

    #[validate(length(min = 8, message = "Password must be at least 8 characters"))]
    pub password: String,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdateUserRequest {
    #[validate(length(min = 3, max = 50, message = "Username must be between 3 and 50 characters"))]
    pub username: Option<String>,

    #[validate(email(message = "Invalid email format"))]
    pub email: Option<String>,

    #[validate(length(max = 500, message = "Bio cannot exceed 500 characters"))]
    pub bio: Option<String>,

    #[validate(url(message = "Image must be a valid URL"))]
    pub image: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub bio: Option<String>,
    pub image: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<crate::models::User> for UserResponse {
    fn from(user: crate::models::User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            email: user.email,
            bio: user.bio,
            image: user.image,
            created_at: user.created_at,
            updated_at: user.updated_at,
        }
    }
}
```

Let me explain each DTO structure:

#### CreateUserRequest 
This defines exactly what we expect when someone registers a new account. Notice it only has `username`, `email`, and `password` - the client doesn't provide `id` (generated by database), `password_hash` (we hash the password), `bio`/`image` (optional), or timestamps (set by database). The validation attributes ensure usernames are reasonable length, emails are valid format, and passwords meet minimum security requirements.
#### UpdateUserRequest
This handles profile updates where all fields are optional. Users might want to update just their bio without changing their username or email. The validation rules are similar but adapted for optional fields. Notice we limit bio length to prevent abuse and validate image URLs.
#### UserResponse
This defines what we send back to clients. Critically, it excludes `password_hash` to ensure we never accidentally expose password hashes. The `From` trait implementation provides automatic conversion from our database User model to the API response format.

The `validator` crate lets us declaratively define validation rules. `length` enforces minimum and maximum string length, `email` validates email format using standard regex, and `url` validates URL format for profile images.

The `From` trait implementation creates a bridge between our database model and API response. While `UserResponse`defines _what_ we send to clients, the `From` trait defines _how_ to convert from our database model:
```rust
impl From<crate::models::User> for UserResponse {
    fn from(user: crate::models::User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            email: user.email,
            bio: user.bio,
            image: user.image,
            created_at: user.created_at,
            updated_at: user.updated_at,
        }
    }
}
```

Why use this instead of manual conversion?
Without `From`, we would manually create responses everywhere:
```rust
let response = UserResponse {
    id: user.id,
    username: user.username,
    email: user.email,
    bio: user.bio,
    image: user.image,
    created_at: user.created_at,
    updated_at: user.updated_at,
};
```

With `From`, we will get automatic conversion:
```rust
let response: UserResponse = user.into();
```

**Why only for responses, not requests?**
We don't implement `From<CreateUserRequest> for User` because request conversion requires business logic:
- Password hashing (can fail)
- ID generation
- Validation
- External dependencies

The `From` trait is perfect for simple field mapping (database → API), but request processing belongs in the service layer where it can handle errors and business logic properly.
### Setting Up the Schema Module
Let's update `src/schemas/mod.rs`:
```rust
pub mod user_schemas;

pub use user_schemas::{CreateUserRequest, UpdateUserRequest, UserResponse};
```

## Integrating with Our Existing Application
Now we need to integrate our new User model and repository with the existing Axum server we built in previous articles.
### Update Module Declarations

First, create a file `src/lib.rs` and add the new modules to `src/lib.rs`:
```rust
pub mod handlers;
pub mod models;      // Add this
pub mod repositories; // Add this
pub mod schemas;     // Add this
pub mod state;
```

The `lib.rs` file defines our library's public API and is required for testing and documentation generation. Even though we're building a binary application, having `lib.rs` properly configured allows future expansion and makes our code testable.
### Update Cargo.toml Dependencies
We need to add the database and validation dependencies to our `Cargo.toml`:
```toml
[package]
name = "realworld-axum-api"
version = "0.1.0"
edition = "2021"

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
```

### Update Application State
Now we need to modify `src/state.rs` to include our UserRepository and handle database connection properly:
```rust
use sqlx::PgPool;
use crate::repositories::UserRepository;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub user_repository: UserRepository,
}

impl AppState {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        // Create the database connection pool
        let db = PgPool::connect(database_url).await?;

        // Run migrations automatically
        sqlx::migrate!("./migrations").run(&db).await?;

        // Create the user repository
        let user_repository = UserRepository::new(db.clone());

        Ok(Self {
            db,
            user_repository,
        })
    }
}
```

The changes we made here are making `AppState::new()` async so it can connect to the database, automatically running migrations when the app starts, and including the UserRepository in our application state.

### Update Main Function
Let me break down this `main.rs` function step by step to explain what's happening and why each part is important.
## Import Declarations and Module Setup
```rust
use axum::{routing::get, Router};
use std::env;

mod handlers;
mod models;
mod repositories;
mod schemas;
mod state;

use handlers::health::health_check;
use state::AppState;
```

The first section sets up our imports and module declarations. The `mod` declarations tell Rust about the modules we've created - this is how we make our `models`, `repositories`, and `schemas` directories available to the main function. Without these `mod` declarations, Rust wouldn't know these modules exist.

The `use` statements bring specific items into scope. We're importing the `AppState` struct we just modified and the `health_check` handler from our previous lessons.

## Database Connection and State Creation
```rust
let app_state = AppState::new(&database_url)
    .await
    .expect("Failed to connect to database");

println!("Connected to database successfully!");
```

This is where the major change from previous lessons happens. We're now calling `AppState::new()` which is an async function that:
1. Connects to PostgreSQL using the database URL
2. Runs database migrations automatically to ensure our schema is up to date
3. Creates the UserRepository and stores it in the app state

The `.await` is necessary because connecting to a database is an async operation - it might take time and we don't want to block other operations. The `.expect()` will crash the program if database connection fails, which is appropriate since we can't run a web API without a database.

The success message lets us know the database connection worked. After finishing authentication article, we will work on integrating better logging system.

## Router Setup with State

```rust
let app = Router::new()
    .route("/health", get(health_check))
    .with_state(app_state);
```

We create our Axum router and add the health check route from previous lessons. The key addition is `.with_state(app_state)` which makes our application state (including the database connection pool and UserRepository) available to all route handlers.

When we build authentication endpoints in the next lesson, they'll be able to access the UserRepository through this shared state.

## Server Startup

```rust
let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
println!("Server running on http://localhost:3000");

axum::serve(listener, app).await.unwrap();
```

This creates a TCP listener on port 3000 and starts the Axum server. The `0.0.0.0` binding means the server accepts connections from any IP address, not just localhost. Both operations are async because network operations can take time.

> I've given a brief explaination on async operations on first article of this series but I'll create a async programming series in future where we will build our own async runtime to understand how it works in depth.

## What Happens When You Start the Server

When you run `cargo run`, here's the complete sequence:
1. Reads `.env` file for configuration
2. Connects to PostgreSQL using the connection pool
3. Automatically runs any pending database migrations
4. Creates UserRepository with the database connection
5. Packages everything into AppState
6. Creates Axum router with routes and shared state
7. Binds to port 3000 and starts accepting HTTP requests
## Module Organization and Rust Project Structure

Let's see how we organized our code:

```
src/
├── handlers/        # API endpoint handlers
│   └── health.rs   # Health check handler
├── models/          # Database entity definitions
│   ├── mod.rs      # Module exports
│   └── user.rs     # User model
├── repositories/    # Data access layer
│   ├── mod.rs      # Module exports
│   └── user_repository.rs  # User data operations
├── schemas/         # API request/response definitions
│   ├── mod.rs      # Module exports
│   └── user_schemas.rs     # User DTOs
└── state.rs         # Application state
└── lib.rs             # Module declarations
```

This structure gives us separation of concerns where `models/` contains pure data structures that mirror database tables, `repositories/` handles database operations and queries, `schemas/` defines API contract definitions, and `state.rs`manages our application's shared state including database connections.

The dependencies are clear, repositories depend on models, schemas can convert from models, state depends on repositories, and API handlers will depend on both repositories and schemas through the application state. When you need to find code, it's obvious where to look.

Each module has a `mod.rs` file that controls what's publicly accessible:
```rust
// src/models/mod.rs
pub mod user;

pub use user::User;  // Re-export for convenience
```

This allows other parts of the application to import simply: `use crate::models::User;` instead of `crate::models::user::User`.

## Conclusion
I know this might feel like a boring long article but we have to set this up for the next exciting article that is implementing complete authentication.
This foundation gives us a clean, scalable architecture for user management. The repository pattern isolates database concerns, DTOs provide clear API contracts, and our database design handles common requirements like uniqueness constraints and automatic timestamps.

In the next lesson, we'll build on this foundation to implement a complete authentication system with JWT including email verification and forget password, OAuth with Google, 2FA, magic link, password hashing, and the actual API endpoints for user registration and login.

I hope you're excited because next one is going to be a very engaging and hands on article with a lot of conceptual learning and implementation. See you soon.
