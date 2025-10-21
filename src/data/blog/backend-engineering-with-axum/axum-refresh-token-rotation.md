---
title: "Axum Backend Series: Refresh Token Rotation and Reuse Detection"
description: "Implementing refresh token rotation and token reuse detection in axum"
pubDatetime: 2025-10-20T19:30:00Z
tags: ["rust", "axum", "backend", "refresh-token", "jwt", "auth"]
series: "Backend Engineering in Axum"
seriesOrder: 8
featured: true
ogImage: ../../../assets/images/axum-backend-engineering/refresh-token-rotation/refresh-token-rotation-cover-image.png
---

In the last post, we built a simple refresh-token flow where the refresh token never expires.

Get the source code from here --> https://github.com/0xshadow-dev/realworld-axum-api

So today we are going to fix that by adding 4 mechanisms that'll improve our refresh token system:
- Token Expiration
- Token Rotation
- Reuse Detection
- Basic Logout

We’ll learn about what each does, why it matters, and then we’ll implement them in code.
## The Problems (and There Are a Few)
Before we touch a single line of Rust, let’s talk about what’s wrong with what we have now.

If someone steals your refresh token, they own your account indefinitely.
You can’t revoke it. You can’t detect it. You can’t stop it.

Why?
- The token never expires
- It never changes
- There’s no way to detect reuse
- You can’t revoke it (no logout yet)

So once it leaks, that’s game over.
## The Solution
Let’s fix this problem by adding four things.
### 1. Token Expiration (7 days)
Refresh tokens will now die after 7 days.
Even if stolen, they can’t live forever.
### 2. Token Rotation
Every time the user refreshes, they’ll get a **new** refresh token and the old one becomes invalid.
So each token is single use.
> Why that helps? We’ll get into that in the next section.

### 3. Reuse Detection
If someone tries to use an old, rotated-out token, we’ll catch it.
That’s how we spot token theft _as it happens_.
> Actual user would never(they might but in general they won't) use a previous or old refresh token.
### 4. Basic Logout
A simple `/logout` endpoint that marks refresh tokens as revoked.  So users can finally sign out cleanly.

> In the next article, we’ll make logout smarter, supporting multi-device session management.

> I would request you to re read if you are confused on something. After implementing the entire thing, you should be able to understand the entire flow with ease.
## Understanding Token Rotation
This is the core of everything we’re doing here.
If you get this part, the rest will click naturally.

Let’s first understand how things currently work and why that’s a huge problem.
### How It Works Now
Right now, our refresh flow looks like this:
```
Login:
→ Get refresh_token_ABC

After 15 minutes (access token expires):
→ Send refresh_token_ABC to /api/auth/refresh
→ Get new access_token
→ refresh_token_ABC is STILL VALID

After another 15 minutes:
→ Send refresh_token_ABC again
→ Get new access_token
→ refresh_token_ABC is STILL VALID

Forever.
```

So yeah, that single token can live forever.

If someone steals `refresh_token_ABC`, they can hit `/refresh` and create access tokens forever, there's no expiration, no invalidation, no detection.

This is clearly an issue. To solve this issue, we are first adding the refresh token expiration mechanism. But we will improve it even more by adding refresh token rotation.

Let me explain exactly what I mean by that.
### How It Should Work (With Rotation)
Here’s the improved flow:
```
Login:
→ Get refresh_token_A

After 15 minutes:
→ Send refresh_token_A to /api/auth/refresh
→ Get new access_token + refresh_token_B
→ refresh_token_A is now DEAD (marked as used)

Next refresh:
→ Send refresh_token_B to /api/auth/refresh
→ Get new access_token + refresh_token_C
→ refresh_token_B is now DEAD
```

Now the refresh token changes every time.
Each one is **single-use**, **short-lived**, and **traceable**.

You probably realising how this is better but let me explain clearly how this is a better solution:
1. Each refresh token works **once**.  Once it’s used, it’s dead
2. Even if stolen, it expires after 7 days.
3. If an attacker tries to use an _old_ token, we’ll instantly know.  That’s where reuse detection comes in (we will learn about that next).
4. Attackers can’t sit on one stolen token forever, that'll expire as soon as the actual user requires to refresh.

Let me explain you with a simple flow.
### Real-World Example
Let’s say you log in and get `refresh_token_A`.
You use it once, you get `refresh_token_B`.
Now someone steals `refresh_token_A` and tries to use it again later.

What happens?
We’ll see that `A` was already used, and we’ll treat that as a **reuse event** which means _“this token was stolen.”_

From there, we can revoke all tokens for that user, log them out everywhere, and send a security alert email.
## Reuse Detection
Now that we have rotation, we can add **reuse detection**, the ability to detect when someone tries to use an old (invalid) token.

Imagine your token chain looks like this:
```
A → B → C → D
```

Each time we issue a new token, we mark the old one as “used”.
If a request comes in with a used token (say, `B`), that means someone’s trying to reuse it, probably an attacker.

This is what will happen next:
1. Check if the refresh token is valid _and unused_.
2. If it’s used → detect reuse.
3. In that case:
    - Invalidate the entire token family.
    - Log the user out everywhere.
    - Optionally log or alert the event.

This is how we stop attackers in their tracks, even if they’ve already stolen something.
## Basic Logout (Manual Token Revocation)
Now, logout.  TO do this we will just revoke the current refresh token for that particular user.

Here’s what we’ll do:
1. User hits `/api/auth/logout`.
2. We find their refresh token in the database.
3. Mark it as revoked (or delete it).
4. Any future request using that token instantly fails (401 Unauthorized).
This gives users control and lets us terminate sessions immediately — no waiting for expiration.


Ok, enough talk, lets write some code.
## Database Schema Changes
First, we need to add columns to track expiration and usage (is it already used or not). To do this, we ned to add 3 new columns.

### Create the Migration
As we did before, lets create a migration to update our DB schema:
```bash
sqlx migrate add add_token_rotation_fields
```

This creates a new file: `migrations/0006_add_token_rotation_fields.sql`

### Writing the Migration Code
Open that file and add this SQL:
```sql
-- Migration 0006: Add token rotation and expiration fields

-- Add new columns to refresh_tokens table
ALTER TABLE refresh_tokens
ADD COLUMN expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
ADD COLUMN is_used BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN used_at TIMESTAMP WITH TIME ZONE;

-- Add index for checking expired tokens (for cleanup jobs)
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- Add index for checking if token was used (for reuse detection)
CREATE INDEX idx_refresh_tokens_is_used ON refresh_tokens(is_used);

-- Update existing tokens to have expiration (7 days from now)
UPDATE refresh_tokens
SET expires_at = NOW() + INTERVAL '7 days'
WHERE expires_at IS NULL;
```

Let me explain what each part does:
**expires_at column:**
```sql
ADD COLUMN expires_at TIMESTAMP WITH TIME ZONE NOT NULL
DEFAULT (NOW() + INTERVAL '7 days')
```
- Every token expires 7 days after creation
- `DEFAULT` means new tokens automatically get this expiration
- Existing tokens will be updated at the end

**is_used column:**
```sql
ADD COLUMN is_used BOOLEAN NOT NULL DEFAULT FALSE
```
- Tracks whether token was already exchanged
- Starts as `false` (not used yet)
- Set to `true` when token is consumed
- This is KEY for reuse detection!

**used_at column:**
```sql
ADD COLUMN used_at TIMESTAMP WITH TIME ZONE
```
- Records WHEN the token was used
- `NULL` means never used
- Useful for audit logs and investigation
- "This token was used on Oct 20 at 3:42 PM"

**Indexes for performance:**
```sql
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX idx_refresh_tokens_is_used ON refresh_tokens(is_used);
```
- Fast lookups when checking expiration
- Fast reuse detection queries
- Important for performance at scale

**Update existing tokens:**

```sql
UPDATE refresh_tokens
SET expires_at = NOW() + INTERVAL '7 days'
WHERE expires_at IS NULL;
```

- Gives existing tokens a 7-day expiration
- Prevents breaking old tokens immediately
- Migration is backwards-compatible

### Run the Migration
Now let's apply these changes:
```bash
sqlx migrate run
```

You should see:
```
Applied 6/migrate add token rotation fields (XX.XXms)
````

## Update Refresh Token Model
Now, we need to update our Rust `RefreshToken` model to match our database schema.

Open `src/models/refresh_token.rs` and replace it with this:
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
    pub expires_at: DateTime<Utc>,      // NEW
    pub is_used: bool,                   // NEW
    pub used_at: Option<DateTime<Utc>>, // NEW
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}

impl RefreshToken {
    // Check if token has expired
    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }

    // Check if token is valid (not expired AND not used)
    pub fn is_valid(&self) -> bool {
        !self.is_expired() && !self.is_used
    }
}
```

Let me explain what we did:
Three new fields:
```rust
pub expires_at: DateTime<Utc>,      // When token dies
pub is_used: bool,                   // Was it exchanged?
pub used_at: Option<DateTime<Utc>>, // When was it used?
```
These match our database columns exactly. SQLx will automatically map them when we query.

### Helper Methods
These helper methods make our code much cleaner.
#### `is_expired()`:
```rust
pub fn is_expired(&self) -> bool {
    Utc::now() > self.expires_at
}
```
Simple check: is the current time past the expiration time?
#### `is_valid()`:
```rust
pub fn is_valid(&self) -> bool {
    !self.is_expired() && !self.is_used
}
```
A token is valid only if:
- It hasn't expired yet
- AND it hasn't been used yet


## Update Repository Trait
We need to add a method to mark tokens as used (for rotation). This is important for detecting reuse

Open `src/repositories/traits.rs` and find the `RefreshTokenRepositoryTrait`. We'll add one new method to it.

Update the trait to look like this:
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

    // NEW METHOD - Mark token as used for rotation
    async fn mark_token_as_used(&self, token: &str) -> Result<(), SqlxError>;
}
```

When we exchange a refresh token for a new one, we mark the old token as "used". This is how we detect reuse later.

## Implement Repository Methods
Now let's implement this new method in our repository.

Open `src/repositories/refresh_token_repository.rs` and we need to make TWO changes:
### Update `create_token` to Include Expiration

Find the `create_token` method and update it to use the new schema:
```rust
async fn create_token(
    &self,
    user_id: Uuid,
    token: &str,
) -> Result<RefreshToken, sqlx::Error> {
    let refresh_token = sqlx::query_as::<_, RefreshToken>(
        r#"
        INSERT INTO refresh_tokens (user_id, token)
        VALUES ($1, $2)
        RETURNING id, user_id, token, expires_at, is_used, used_at, created_at, last_used_at
        "#,
    )
    .bind(user_id)
    .bind(token)
    .fetch_one(&self.db)
    .await?;

    Ok(refresh_token)
}
```

We added the new fields to the `RETURNING` clause:
```sql
RETURNING id, user_id, token,
          expires_at, is_used, used_at,  -- NEW FIELDS
          created_at, last_used_at
```
The database will automatically set:
- `expires_at = NOW() + 7 days` (from our DEFAULT)
- `is_used = false` (from our DEFAULT)
- `used_at = NULL` (not used yet)
### Update `find_by_token` to Include New Fields
Find the `find_by_token` method and update it:
```rust
async fn find_by_token(&self, token: &str) -> Result<Option<RefreshToken>, sqlx::Error> {
    let refresh_token = sqlx::query_as::<_, RefreshToken>(
        r#"
        SELECT id, user_id, token, expires_at, is_used, used_at, created_at, last_used_at
        FROM refresh_tokens
        WHERE token = $1
        "#,
    )
    .bind(token)
    .fetch_optional(&self.db)
    .await?;

    Ok(refresh_token)
}
```

We're now selecting the new fields:
```sql
SELECT id, user_id, token,
       expires_at, is_used, used_at,  -- NEW FIELDS
       created_at, last_used_at
```

This way our `RefreshToken` struct gets all the data it needs.

### Add the New `mark_token_as_used` Method
Now add this NEW method at the end of the `impl RefreshTokenRepositoryTrait` block:
```rust
async fn mark_token_as_used(&self, token: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE refresh_tokens
        SET is_used = TRUE,
            used_at = $1
        WHERE token = $2
        "#,
    )
    .bind(Utc::now())
    .bind(token)
    .execute(&self.db)
    .await?;

    Ok(())
}
```

When we call `mark_token_as_used("old-token-123")`, it:
1. Sets `is_used = TRUE`, basically marks the token as consumed or used
2. Sets `used_at = NOW()` to record when it was used
3. Finds the token by its value

After this, if someone tries to use `old-token-123` again, we'll see `is_used = TRUE` and know it's reuse
## Update Response Schemas
Before we update the handlers, we need to fix our response schemas. The refresh endpoint needs to return BOTH tokens now (not just the access token).

Open `src/schemas/token_schemas.rs` and update the `RefreshTokenResponse`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub refresh_token: String,  // NEW - We return a new refresh token
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

We added `refresh_token` to the response:
```rust
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub refresh_token: String,  // NEW!
}
```

**Why?** Because with token rotation, every refresh gives you:
1. A new access token (15 min JWT)
2. A NEW refresh token (replaces the old one)

Before, we only returned the access token. Now we return both

The response will look something like this:
```json
{
  "access_token": "eyJhbGc...",     // New 15-min JWT
  "refresh_token": "new-uuid-456"   // New refresh token
}
```
The client needs to store BOTH. The old refresh token is dead.

## Rewrite the Refresh Handler
We're going to completely rewrite the `refresh_token` handler to implement rotation and reuse detection.

Open `src/handlers/auth.rs` and find the `refresh_token` function. Replace it entirely with this:
```rust
pub async fn refresh_token(
    State(state): State<AppState>,
    Json(payload): Json<RefreshTokenRequest>,
) -> Result<Json<RefreshTokenResponse>, StatusCode> {
    // Step 1: Find the refresh token in database
    let refresh_token = state
        .refresh_token_repository
        .find_by_token(&payload.refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Step 2: Check if token has expired
    if refresh_token.is_expired() {
        // Token is expired, delete it and reject
        let _ = state
            .refresh_token_repository
            .delete_token(&payload.refresh_token)
            .await;

        return Err(StatusCode::UNAUTHORIZED);
    }

    // Step 3: REUSE DETECTION - Check if token was already used
    if refresh_token.is_used {
        // SECURITY BREACH DETECTED!
        // Someone is trying to use an old token
        // This means the token was likely stolen

        eprintln!("TOKEN REUSE DETECTED!");
        eprintln!("Token: {}", &payload.refresh_token);
        eprintln!("User ID: {}", refresh_token.user_id);
        eprintln!("Originally used at: {:?}", refresh_token.used_at);

        // Nuclear option: Delete ALL user's refresh tokens
        // Force them to login again
        state
            .refresh_token_repository
            .delete_all_user_tokens(refresh_token.user_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        // TODO: Send security alert email (we'll add this later)

        return Err(StatusCode::UNAUTHORIZED);
    }

    // Step 4: Mark the old token as used (consumed)
    state
        .refresh_token_repository
        .mark_token_as_used(&payload.refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Step 5: Generate NEW refresh token with rotation
    let new_refresh_token = generate_refresh_token();

    state
        .refresh_token_repository
        .create_token(refresh_token.user_id, &new_refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Step 6: Generate new access token
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let access_token = generate_token(&refresh_token.user_id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Step 7: Return BOTH tokens
    Ok(Json(RefreshTokenResponse {
        access_token,
        refresh_token: new_refresh_token,
    }))
}
```

Whoa, that's a lot! Let me break it down step by step:
### Step 1: Find the Token
```rust
let refresh_token = state
    .refresh_token_repository
    .find_by_token(&payload.refresh_token)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
```
We look up the token in the database. If it doesn't exist → `401 Unauthorized`.

Why might it not exist?
- User logged out (token was deleted)
- Token never existed (invalid)
### Step 2: Check Expiration
```rust
if refresh_token.is_expired() {
    // Token is expired, delete it and reject
    let _ = state
        .refresh_token_repository
        .delete_token(&payload.refresh_token)
        .await;

    return Err(StatusCode::UNAUTHORIZED);
}
```

Has the token passed its 7-day expiration? If yes:
1. Delete it from the database (cleanup)
2. Return `401 Unauthorized`

The user needs to login again.
### Step 3: Reuse Detection
```rust
if refresh_token.is_used {
    // SECURITY BREACH DETECTED
    eprintln!("TOKEN REUSE DETECTED!");
    eprintln!("Token: {}", &payload.refresh_token);
    eprintln!("User ID: {}", refresh_token.user_id);
    eprintln!("Originally used at: {:?}", refresh_token.used_at);

    // Delete ALL user's refresh tokens
    state
        .refresh_token_repository
        .delete_all_user_tokens(refresh_token.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    return Err(StatusCode::UNAUTHORIZED);
}
```

If `is_used = true`, it means this token was already exchanged for a new one. Someone trying to use it again is PROOF of theft

**What we are doing after checking is the token is already used:**
1. Log the security incident (with details)
2. Delete ALL the user's refresh tokens (nuclear option)
3. Reject the request

The legitimate user will be logged out too, but they'll get a security email explaining why.

> We will add the email mechanism later in this article.

### Step 4: Mark Token as Used
```rust
state
    .refresh_token_repository
    .mark_token_as_used(&payload.refresh_token)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
```

If the token is valid and unused, so we mark it as consumed:
- `is_used = true`
- `used_at = NOW()`
From this point on, if anyone tries to use this token, Step 3 will catch them
### Step 5: Generate New Refresh Token
```rust
let new_refresh_token = generate_refresh_token();

state
    .refresh_token_repository
    .create_token(refresh_token.user_id, &new_refresh_token)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
```

We generate a brand new UUID token and save it to the database. This token:
- Has a fresh 7-day expiration (from the DEFAULT)
- Is marked as `is_used = false`
- Belongs to the same user

This is the **rotation** part. At this point, we took the refresh token from the user, marked that are used and then we create a new refresh token and marking is as not used and associating this new refresh token with the same user.

### Step 6: Generate New Access Token
```rust
let jwt_secret = std::env::var("JWT_SECRET")
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
let access_token = generate_token(&refresh_token.user_id, &jwt_secret)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
```

As we understood previously, we will send a new access and refresh token at every refresh. Hence, we are creating a new JWT access token

Standard JWT generation, nothing new here. 15-minute expiration.
### Step 7: Return Both Tokens
```rust
Ok(Json(RefreshTokenResponse {
    access_token,
    refresh_token: new_refresh_token,
}))
```

We return BOTH tokens to the client:
```json
{
  "access_token": "eyJhbGc...",
  "refresh_token": "new-uuid-456"
}
```

> The client MUST replace their old refresh token with the new one

### The Complete Flow Visualization
Let me show you how this works in practice:
```
Client Request:
POST /api/auth/refresh
Body: { "refresh_token": "old-abc-123" }

Server Process:
1. Find "old-abc-123" in database ✓
2. Check expired? No ✓
3. Check is_used? No ✓
4. Mark "old-abc-123" as used
5. Generate "new-xyz-789"
6. Save "new-xyz-789" to database
7. Generate new JWT access token

Server Response:
{
  "access_token": "eyJ...",
  "refresh_token": "new-xyz-789"
}

Client Action:
- Store new access token
- Store "new-xyz-789"
- DELETE "old-abc-123"

Database State:
Token: "old-abc-123" | is_used: TRUE  | used_at: 3:42 PM
Token: "new-xyz-789" | is_used: FALSE | used_at: NULL
````

The old token is dead, and we have a fresh one
## Implement Basic Logout
Now let's give users the power to revoke their own tokens. This is the basic logout, just deleting a single refresh token.

Add this new handler to `src/handlers/auth.rs`:
```rust
pub async fn logout(
    State(state): State<AppState>,
    Json(payload): Json<LogoutRequest>,
) -> Result<Json<LogoutResponse>, StatusCode> {
    // Simply delete the refresh token from database
    state
        .refresh_token_repository
        .delete_token(&payload.refresh_token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(LogoutResponse {
        message: "Logged out successfully".to_string(),
    }))
}
```

## Add Security Alert Email
When we detect token reuse, we should notify the user. Let's add that email

Open `src/services/email_service.rs` and add this new method:
```rust
pub async fn send_security_alert(
    &self,
    to_email: &str,
    username: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let html_body = format!(
        r#"
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body {{ font-family: Arial, sans-serif; line-height: 1.6; color: #333; }}
                .container {{ max-width: 600px; margin: 0 auto; padding: 20px; }}
                .header {{ background-color: #dc3545; color: white; padding: 20px; text-align: center; }}
                .content {{ background-color: #f9f9f9; padding: 30px; border-radius: 5px; margin-top: 20px; }}
                .alert-box {{ background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }}
                .action-box {{ background-color: #d1ecf1; border-left: 4px solid #0c5460; padding: 15px; margin: 20px 0; }}
                .footer {{ text-align: center; margin-top: 20px; color: #666; font-size: 12px; }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Security Alert</h1>
                </div>
                <div class="content">
                    <h2>Hi {}!</h2>
                    <p>We detected suspicious activity on your account.</p>

                    <div class="alert-box">
                        <h3>What Happened?</h3>
                        <p>Someone attempted to use an old access token that had already been exchanged for a new one.</p>
                        <p>This usually means your token was stolen and someone else is trying to access your account.</p>
                    </div>

                    <div class="action-box">
                        <h3>What We Did</h3>
                        <ul>
                            <li>Blocked the suspicious request</li>
                            <li>Logged you out of all devices</li>
                            <li>Your account is now secure</li>
                        </ul>
                    </div>

                    <h3>What You Should Do</h3>
                    <ol>
                        <li><strong>Login again</strong> with your password</li>
                        <li><strong>Review recent activity</strong> on your account</li>
                        <li><strong>Change your password</strong> if you suspect compromise</li>
                        <li><strong>Enable 2FA</strong> if available (coming soon!)</li>
                    </ol>

                    <p><strong>When did this happen?</strong><br>
                    Just now - we detected and blocked it immediately.</p>

                    <p><strong>What if this wasn't you?</strong><br>
                    This is expected behavior if you were logged in on multiple devices. However, if you weren't actively using the app, someone may have your token.</p>

                    <p>If you have any questions or concerns, please contact our support team.</p>
                </div>
                <div class="footer">
                    <p>© 2024 AxumAPI. All rights reserved.</p>
                    <p>This is an automated security alert. Please do not reply to this email.</p>
                </div>
            </div>
        </body>
        </html>
        "#,
        username
    );

    let email = Message::builder()
        .from(self.from_email.clone())
        .to(to_email.parse()?)
        .subject("Security Alert: Suspicious Activity Detected")
        .header(ContentType::TEXT_HTML)
        .body(html_body)?;

    self.mailer.send(&email)?;

    println!("Security alert sent to {}", to_email);

    Ok(())
}
```

Basically we are informing user about a certain login activity.

> We will improve this in future articles with location and device tracking.
### Update the Refresh Handler to Send Email
Now let's use this email. Go back to `src/handlers/auth.rs` and update the reuse detection part:

Find this section in the `refresh_token` function:
```rust
if refresh_token.is_used {
    eprintln!("🚨 TOKEN REUSE DETECTED!");
    eprintln!("Token: {}", &payload.refresh_token);
    eprintln!("User ID: {}", refresh_token.user_id);
    eprintln!("Originally used at: {:?}", refresh_token.used_at);

    // Delete ALL user's refresh tokens
    state
        .refresh_token_repository
        .delete_all_user_tokens(refresh_token.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // TODO: Send security alert email

    return Err(StatusCode::UNAUTHORIZED);
}
```

Replace it with this:
```rust
if refresh_token.is_used {
    eprintln!("TOKEN REUSE DETECTED!");
    eprintln!("Token: {}", &payload.refresh_token);
    eprintln!("User ID: {}", refresh_token.user_id);
    eprintln!("Originally used at: {:?}", refresh_token.used_at);

    // Delete ALL user's refresh tokens (force logout everywhere)
    state
        .refresh_token_repository
        .delete_all_user_tokens(refresh_token.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Get user info for email
    let user = state
        .user_repository
        .find_by_id(refresh_token.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    // Send security alert email
    if let Err(e) = state
        .email_service
        .send_security_alert(&user.email, &user.username)
        .await
    {
        eprintln!("Failed to send security alert email: {}", e);
        // Don't fail the request if email fails
    }

    return Err(StatusCode::UNAUTHORIZED);
}
```
We added:
1. Fetch the user's details (email, username)
2. Send the security alert email
3. If email fails, log it but don't fail the request

Now when token reuse is detected:
1. Request is rejected
2. All tokens are deleted
3. User gets notified
4. Incident is logged (We will improve logging for the entire project in a future article)
## Update Routes
Time to integrate up our new logout endpoint
Update `src/handlers/mod.rs`:
```rust
pub mod auth;
pub mod health;

pub use auth::{
    current_user, forgot_password, login, logout, refresh_token, register, reset_password,
    verify_email,
};
pub use health::health_check;
```

We added `logout` to the exports.

Now update `src/main.rs`:
```rust
use axum::{
    routing::{get, post},
    Router,
};
use std::env;

use realworld_axum_api::{
    handlers::{
        current_user, forgot_password, health_check, login, logout, refresh_token, register,
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
        .route("/api/auth/refresh", post(refresh_token))
        .route("/api/auth/logout", post(logout))  // NEW
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
    println!("  POST /api/auth/refresh           - Get new access token");
    println!("  POST /api/auth/logout            - Logout (delete refresh token)");  // NEW
    println!("  GET  /health                     - Health check");

    axum::serve(listener, app).await.unwrap();
}
```

## Part 13: Testing Everything
Let's run through all the scenarios.
### Start the Server
```bash
cargo run
```
You should see all our endpoints listed, including the new logout endpoint.
### Test 1: Normal Token Rotation
Let's see the refresh token rotation flow

First, lets login.
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

You should see a response like this:
```json
{
  "user": {
    "email": "sam@test.com",
    "username": "sam",
    "bio": "",
    "image": null,
    "email_verified": false
  },
  "access_token": "eyJ0eXAi...",
  "refresh_token": "token-A-uuid-123"
}
```

Save both tokens Let's call the refresh token `token-A`.

Now, lets try to refresh to get new access and refresh tokens.
Now let's use `token-A` to refresh:
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "token-A-uuid-123"
  }'
```

You should get something like this:
```json
{
  "access_token": "eyJ0eXAi...",
  "refresh_token": "token-B-uuid-456"
}
```

You got a NEW refresh token. Let's call this `token-B`.

Let's try to refresh again with our old refresh token.
Now try to use `token-A` again:
````bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "token-A-uuid-123"
  }'
```

Response:
```
Status: 401 Unauthorized
````

**What happened?**
1. Server found `token-A` in database
2. Checked `is_used` → `true`
3. REUSE DETECTED
4. Deleted ALL your refresh tokens (including `token-B`)
5. Sent you a security alert email
6. Rejected the request

Check your email inbox, you should see the security alert

Even the new refresh token is dead. It won't work because one we detect a reuse we remove all the tokens, hence user needs to login again and can't use any previous tokens to get access.

Try to use `token-B`:
````bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "token-B-uuid-456"
  }'
```

Response:
```
Status: 401 Unauthorized
````


## Conclusion
I hope you learned something new today with this article. In the next one, we will either focus on 2FA or multi device management or OAuth. See you soon!
