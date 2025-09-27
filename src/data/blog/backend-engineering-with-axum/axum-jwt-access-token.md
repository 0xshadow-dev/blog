---
title: "Axum Backend Series: Implement JWT Access Token"
description: "Learn about authentication and implement JWT access token in Axum"
pubDatetime: 2025-09-26T19:30:00Z
tags: ["rust", "axum", "backend", "authentication", "jwt"]
series: "Backend Engineering in Axum"
seriesOrder: 4
featured: true
ogImage: ../../../assets/images/axum-backend-engineering/access-token/axum-jwt-access-token-cover-image.png
---


Welcome back! In our previous post, we built the foundation with our User model, repository pattern, and database schema. From today, we are going to learn about authentication in depth with hands on experience. By the end of this post, we will have a endpoint to register users, let them login and built a protected route, so that only logged in users can access that otherwise they'll get an "unauthorized access" error response.

From this post onwards we will dedicate at most 10 articles(I'll try to explain auth in depth and try to wrap auth quickly) to learn and implement:
- JWT authentication (access tokens only) -> We are doing this in this post
- Email verification and password reset
- JWT authentication (improve by adding refresh tokens)
- Refresh token rotation with family tracking for security
- Multi Device Sessions
- Session limit implementation (like 3 devices can be logged in at once not more than that)
- Adding 2FA
- Adding OAuth (like login with Google). Also link already existing account with OAuth login


You can find the source code here --> https://github.com/0xshadow-dev/realworld-axum-api

> We will learn and implement all of this but the order might change. I wanted to keep everything in 1 or 2 posts but I realised it'll become too big and most of the readers won't be able to finish reading it or might leave midway. By doing this many articles, I can keep them short and one auth feature implementation per post. So, lets continue.

Let me start by explaining what authentication actually is and then we will go through different authentication methods until we reach JWT tokens.

## What is Authentication
Authentication is about verifying that someone is who they claim to be. In context of web apps, this means confirming that the person trying to access an account actually owns that account.

When we build a web app, we need to take care of this problem that is how do we know which user is making each request? Every time someone sends a request to our server, we need to check whether they're logged in and which user they represent.

## Basic Authentication
Let's start by learning about some of the ways we can handle this authentication issue and the simplest way is called "Basic Authentication".

In this, the user or the client sends the username and password with every single HTTP request.

The credentials are encoded in a special header that looks like this:

```
Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=
```

The part after "Basic" is just the username and password joined with a colon and then base64 encoded. So "username:password" becomes "dXNlcm5hbWU6cGFzc3dvcmQ=".

Let me explain how it works on our browser:

```bash
GET /api/user/profile
Authorization: Basic am9objpzZWNyZXRwYXNz
```

Our browser sends a `GET` request and an `Authorization` header, then the server receives the request, decodes the authorization header to get "john:secretpass", then it checks if this username and password combination exist in our database or not. If yes, then the request is successful otherwise it'll return an error.

You might think, ok this makes sense but think for a second. Is it really a great idea to check username and password for every single request. If we have thousands of users making hundreds of requests each, this becomes a massive database bottleneck.

Another problem is that even though the requests are base64 encoded, base64 is not encryption, its just encoding, so anyone who intercepts the request can easily decode and see the credentials.

Ok, so due to these problems we need to find another way to solve auth issue.

## Session-Based Authentication

To solve the problems with basic authentication, we got session-based authentication. This gives us a concept of session, it is a temporary period during which a user is considered logged in.

Let me explain how it works:

When a user first logs in, they send their username and password like basic authentication. The server gets the request and verifies these credentials against the database and if they're correct, the server creates a session. This session is basically a record that says "user John is currently logged in" and its stored on the server, generally in memory or in a database.

Then the server generates a unique session ID, usually a random string called a session ID. Then this session ID is sent back to the client or user as a HTTP cookie.

This is how the cookie might look like:

```bash
Set-Cookie: sessionId=abc123def456; HttpOnly; Secure
```

For all subsequent requests, the client automatically sends this cookie with each HTTP request. When the server receives a request with a session ID, it looks up that session ID in its session store. If the session exists and hasn't expired, the server knows which user is making the request.

Session-based authentication solves several problems from Basic Authentication. Credentials are only sent once during login, reducing the risk of interception. The session can have an expiration time, automatically logging out inactive users. Sessions can be invalidated on the server side for immediate logout.

However, session-based authentication introduces new challenges. The server must maintain state by storing session information, which complicates scaling across multiple servers. If you have multiple server instances, they need to share session data, typically through a shared database or memory store like Redis. Sessions can consume significant server memory or database resources as the number of active users grows.

## Token-Based Authentication

Token based authentication came to solve the scalability issue of session based system. In this, instead of the server maintaining session state, all the required information is contained within the token itself.

Let me explain with a example request flow:

When a user logs in successfully, the server creates a token that contains information about the user. This token is cryptographically signed by the server to prevent tampering. The token is sent to the client, and the client includes this token in the authorization header of subsequent requests.

The key difference is that the server doesn't need to store anything about active sessions. When a request comes in with a token, the server can verify the token's signature to ensure it's authentic and hasn't been modified. If the signature is valid, the server trusts the information contained in the token.

This approach is called "stateless" because the server doesn't maintain any state about logged-in users. Each request is completely independent, and the token contains all the information needed to process the request.

## Introduction to JWT (JSON Web Tokens)

JWT is a specific implementation of token-based authentication that has become the industry standard.

A JWT token consists of 3 parts separated by dots. Each part is there for a specific reason.

The first part is called the **header**. It contains metadata about the token, to be precise it contains which algorithm was used to sign it and what type of token it is. The header is a JSON object that gets base64 encoded.

Let me show you an example of a JWT header:

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

The "alg" field specifies the signing algorithm. HS256 means HMAC SHA-256, which is a symmetric signing algorithm that uses the same secret key for both signing and verification.

> I'm not explaining anything about symmetric algorithm or their types because that'll stretch this article a lot. If you want to learn more about those, then please go ahead but that's not needed for this series.

The "typ" field indicates this is a JWT token.

The second part is the payload, which contains the actual claims or information about the user. Claims are statements about an entity, typically the user. The payload is also a JSON object that gets base64 encoded. A typical payload might look like:

```json
{
  "sub": "12345",
  "email": "john@example.com",
  "exp": 1516239022,
  "iat": 1516235422
}
```

The "sub" field stands for "subject" and typically contains the user's unique identifier. The "email" field contains the user's email address. The "exp" field is the expiration time as a Unix timestamp, after which the token should not be accepted. The "iat" field is "issued at" and contains the timestamp when the token was created.

The third part is the signature, which is the most important part for security. The signature is created by taking the base64-encoded header and payload, joining them with a dot, and then signing this string with the **secret key** using the algorithm specified in the header.

## The JWT Secret Key
The secret key is the most critical component of JWT security. It's a piece of data that only your server knows, and it's used to both create and verify JWT signatures. The secret key is what proves a JWT token actually came from your server.

The secret key is a string of characters that should be completely random and unpredictable. It could look something like this:

```
my-super-secret-jwt-key-that-nobody-else-knows-2024
```

Or more securely, it might be a randomly generated string:

```
kJ8#mN9$pQ2!rS5@tU7%vW1&xY3*zA6^bC4#dE8$fG0!
```

The longer and more random the secret key, the more secure your JWT tokens will be.

When your server creates a JWT token, it uses the secret key in the signing process. To create the signature, you would do something like:

```
signature = HMACSHA256(
  base64UrlEncode(header) + "." + base64UrlEncode(payload),
  secret_key
)
```

The complete JWT token is formed by joining all three parts with dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

The security of JWT relies entirely on the fact that only your server knows the secret key. When someone tries to verify a JWT token, they need to recreate the signature using the same algorithm and the same secret key. If they don't have the correct secret key, they cannot produce the correct signature.

If an attacker intercepts a JWT token and tries to modify the payload to change the user ID, they can easily modify the payload because it's just base64 encoded, not encrypted. However, when they modify the payload, the signature becomes invalid because the original signature was created from the original payload. Since the attacker doesn't know your secret key, they can't create the new signature that would be required for the modified payload.

## How JWT Verification Works

When a client sends a JWT token to the server, the server has to verify that the token is valid and hasn't been tampered with.

First, the server splits the token into 3 parts by looking for the dot separators. Then, it base64 decodes the header and payload to extract the JSON objects. From the header, the server gets which algorithm was used to sign the token.

Next, the server recreates the signature by taking the original encoded base64 header and payload and signing them with the same secret key and algorithm that was used originally. This creates a new signature.

The server then compares this newly created signature with the signature that came with the token. If they match exactly, it proves two things: first, that the token was indeed created by someone who knows the secret key (which should only be the server), and second, that the header and payload haven't been modified since the token was created.

If the signatures match, the server then checks the claims in the payload. It verifies that the token hasn't expired by comparing the "exp" claim with the current time. It might also check other claims depending on the application's requirements.

Only if all these verification steps pass does the server consider the token valid and trust the information contained within it.

## Two Token Strategy: Access and Refresh Tokens

While JWT solves many problems, it introduces a new challenge: token revocation. Since JWT tokens are stateless and self-contained, there's no easy way to invalidate them before they expire. If a token is compromised, it remains valid until its expiration time.

To address this, many systems implement a two-token strategy using access tokens and refresh tokens. Access tokens are short-lived (typically 15 minutes to 1 hour) and are used for actual API authentication. Refresh tokens are longer-lived (typically 7 days to 30 days) and are used only to obtain new access tokens.

When a user logs in, they receive both an access token and a refresh token. The client uses the access token for API requests. When the access token expires, instead of forcing the user to log in again, the client uses the refresh token to request a new access token from the server.


For now, lets not worry about refresh tokens, I'll explain that when we will add that in our auth system. For now, lets just focus on implementing the access token and make our api endpoints protected so that only logged in users can access those endpoints.


Ok, enough theory, let's start working on our authentication feature. In this post, we are going to build a functional authentication system that'll only use access token and have endpoints for registering user and login. Then we will create another protected endpoint to check if our authentication system is correctly allowing or restricting user depending on their login status.

We're building a complete JWT authentication system with registration, login, and protected routes. By the end of this post, you'll have working endpoints you can test in Postman.

## What We're Building

We'll add these endpoints to our existing API:

- `POST /api/users` - User registration with password hashing
- `POST /api/users/login` - User login with credential verification
- `GET /api/user` - Get current user (protected route)

## Adding Dependencies
As usual, before we start coding, we need two new dependencies for our authentication system.

Add these to your `Cargo.toml`:
```toml
# Add these to your existing dependencies
bcrypt = "0.15"
jsonwebtoken = "9.0"
```

- `bcrypt` - handles password hashing as we never store password in plain text.
- `jsonwebtoken` - handles JWT creation and validation. This is the same crate used by most Rust web frameworks.


## Password Hashing and Verifying with Bcrypt

Let's start with the simplest thing, that is hashing and verifying password. It is simple because it'll be handled by `bcrypt` and we don't need to think too much.

Create a file `src/auth/password.rs`:

```rust
use bcrypt::{hash, verify, DEFAULT_COST};

pub fn hash_password(password: &str) -> Result<String, bcrypt::BcryptError> {
    // Cost factor 12 - good balance of security vs performance
    hash(password, DEFAULT_COST + 2)
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, bcrypt::BcryptError> {
    verify(password, hash)
}
```

Let me first explain why hashing is needed at first place and then I'll explain that "cost" we are using while hashing the password.

### Why Hash the Password

So, just think of a scenario where our database gets hacked. If we store the passwords in simple text like:

```text
john@email.com | password123
jane@email.com | mypassword
mike@email.com | 123456
```

Then, the hacker has everyone's actual passwords. So to eliminate this problem we hash the passwords before storing in our database.

This is how it looks when anyone would see the user's data in our database:

```text
john@email.com | 5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8
jane@email.com | 89e01536ac207279409d4de1e5253e01f4a1769e696db0d6062ca9b8f56767c8
mike@email.com | 8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92
```

These are SHA256 hashes. Even if a hacker gets our database, they can't "reverse" these hashes to get the original password.

### Why Can't Hashes Be Reversed?

Think of hashing like putting something through a meat grinder. You can turn a steak into ground meat, but you can't turn ground meat back into the original steak.

Here's what happens when you hash "password123":

```rust
"password123" -> hash function -> "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"
```

The hash function is designed to be a **one-way operation**. It's mathematically easy to go from password to hash, but practically impossible to go from hash back to password.

Why? Because multiple different inputs can produce the same hash (this is called a collision). The hash function takes infinite possible inputs and maps them to a finite number of outputs. It's like trying to figure out which specific number someone was thinking of when they tell you "the remainder when I divide by 10 is 7" - could be 7, 17, 27, 37, etc.

Ok, but there is a problem in this.

### Why Regular Hashing Isn't Enough

SHA256 is designed to be **fast**. That's great for file checksums, but terrible for passwords.

Here's what happens when hackers get your SHA256 password database:

1. They get a list of common passwords (there are billions available online)
2. They hash each password with SHA256
3. They compare the results with your database

With a modern GPU, they can try **billions of passwords per second**. Your users' passwords get cracked in minutes.

```rust
// This is what hackers do (simplified):
let common_passwords = ["password123", "123456", "qwerty", ...];

for password in common_passwords {
    let hash = sha256(password);
    if database_contains(hash) {
        println!("Found password: {}", password);
    }
}
```

This is just a dumbed down example of what they do but I hope you get the point.

This is where we need bcrypt (these days Argon is the new standard, but for now lets stick to bcrypt as you'll get a lot of resource to learn about it).

### What Bcrypt Does?

When you hash a password with bcrypt:

```rust
let hash = hash_password("password123");
// Takes ~400ms on my machine
```

When a hacker tries to crack it:

```rust
// They have to do this for every password guess:
let guess_hash = hash_password("guess1");     // 400ms
let guess_hash = hash_password("guess2");     // 400ms
let guess_hash = hash_password("guess3");     // 400ms
```

Instead of billions of guesses per second, they can only try **2-3 passwords per second**. Cracking your users' passwords becomes impossible. In the Cost Factor section, you'll understand how bcrypt slows down the process.

> In future, we will learn how to lock user's account after multiple failed attempts to improve our security.

### The Cost Factor

Now, let me explain what that "cost" is doing in our hashing code.

Bcrypt has a "cost factor" that controls how slow it is:

```rust
hash(password, 10)  // ~100ms per hash
hash(password, 12)  // ~400ms per hash
hash(password, 14)  // ~1600ms per hash
```

Each +1 doubles the time. We use cost 12 because:

- Fast enough for user login (400ms is barely noticeable)
- Slow enough to stop attackers (2-3 guesses per second max)

### Salt - Preventing Rainbow Tables and How Verification Still Works

Here's where it gets interesting. Bcrypt adds a random "salt" to each password before hashing:

```rust
// Instead of hashing just "password123"
// bcrypt hashes "password123" + "randomsalthere" = "password123randomsalthere"
```

**Wait, if the salt is random each time, how does our server know if the user typed the correct password?**
bcrypt stores the salt **inside** the hash itself.

When you hash a password with bcrypt, you get something like this:

```
$2b$12$LQv3c1yqBWVHxkd0LQ1lQu.WPCRCi4wPIWXK9CwcfEhO1Pq6X.P5C
```

Let me break this down:
- `$2b$` - bcrypt version identifier
- `12` - cost factor (12)
- `LQv3c1yqBWVHxkd0LQ1lQu` - the salt (22 characters)
- `.WPCRCi4wPIWXK9CwcfEhO1Pq6X.P5C` - the actual hash

When a user logs in with "password123", here's what happens:

1. **Extract the salt**: bcrypt reads the stored hash and extracts the salt `LQv3c1yqBWVHxkd0LQ1lQu`
2. **Hash with same salt**: It hashes "password123" + "LQv3c1yqBWVHxkd0LQ1lQu"
3. **Compare results**: If the new hash matches the stored hash, password is correct

This prevents "rainbow table" attacks where hackers pre-compute hashes for common passwords. Even if two users have the same password "password123", they get completely different hashes because each gets a unique random salt:

```
User 1: $2b$12$LQv3c1yqBWVHxkd0LQ1lQu.WPCRCi4wPIWXK9CwcfEhO1Pq6X.P5C
User 2: $2b$12$XYz9d2yqBWVHxkd0LQ1ABC.DEFGCi4wPIWXK9CwcfEhO1Pq6Z.Q7D
```

The hacker can't use pre-computed tables because they'd need different tables for every possible salt - which is computationally impossible.

## JWT Token System

Now that we have secure password handling, let's build the JWT token system. This is what actually identifies users after they log in.

Create `src/auth/jwt.rs`:

```rust
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{Utc, Duration};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,  // user_id
    pub exp: usize,   // expiration
    pub iat: usize,   // issued_at
}

pub fn generate_token(user_id: &Uuid, secret: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let now = Utc::now();
    let exp = (now + Duration::hours(24)).timestamp() as usize;
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

pub fn validate_token(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    )
    .map(|data| data.claims)
}
```

Remember earlier when I explained JWT has three parts? Now we're implementing exactly that.

## How Our JWT Implementation Works

When a user successfully logs in, our `generate_token` function creates a JWT with their user ID inside.

Let's break down what happens:

```rust
let claims = Claims {
    sub: user_id.to_string(),     // "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    exp: (now + Duration::hours(24)).timestamp() as usize,  // Expires in 24 hours
    iat: now.timestamp() as usize,  // Created right now
};
```

The `sub` field contains the user's UUID. The `exp` field sets expiration to 24 hours from now. The `iat` field records when the token was created.
> For a production app, you might want shorter expiration (like 1 hour) and implement refresh tokens to get new access tokens without forcing users to log in again. We'll cover that in future posts.

Then we sign it with our secret key:

```rust
encode(
    &Header::default(),        // Uses HS256 algorithm
    &claims,                   // Our user data
    &EncodingKey::from_secret(secret.as_ref()),  // Our secret key
)
```

This creates a token that looks like:

```
eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmNDdhYzEwYi01OGNjLTQzNzItYTU2Ny0wZTAyYjJjM2Q0NzkiLCJleHAiOjE3NTg1NzQ5MzQsImlhdCI6MTc1ODQ4ODUzNH0.signature-here
```

## Token Validation Process

When someone sends us a request with a token, our `validate_token` function:

1. Splits the token into header, payload, and signature
2. Recreates the signature using our secret key
3. Compares signatures if they match, the token is authentic
4. Checks expiration if `exp` is in the past, token is invalid
5. Returns the claims now we know which user this is

```rust
// If token is valid, we get back the claims:
let claims = validate_token(token, secret)?;
let user_id = Uuid::parse_str(&claims.sub)?;  // Now we know which user!
```


Update `src/auth/mod.rs`:

```rust
pub mod password;
pub mod jwt;
```

## Authentication Middleware

Now we need middleware that automatically checks if requests have valid JWT tokens. Think of middleware as a security guard that checks IDs before letting people into different parts of your building.

We'll create two types of extractors:

- **RequireAuth** - blocks requests without valid tokens (for protected routes)
- **OptionalAuth** - allows requests with or without tokens (for public routes)

Create `src/auth/middleware.rs`:

```rust
use axum::{
    extract::{FromRef, FromRequestParts},
    http::{request::Parts, StatusCode, HeaderMap},
};
use uuid::Uuid;
use crate::{models::User, state::AppState, auth::jwt::validate_token};

// For protected routes - requires valid JWT
pub struct RequireAuth(pub User);

// For optional auth - extracts user if token present
pub struct OptionalAuth(pub Option<User>);

impl<S> FromRequestParts<S> for RequireAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);

        // Extract Authorization header
        let headers = &parts.headers;
        let token =      extract_token_from_headers(headers).ok_or(StatusCode::UNAUTHORIZED)?;

        // Validate JWT token
        let jwt_secret = std::env::var("JWT_SECRET")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        let claims = validate_token(&token, &jwt_secret)
            .map_err(|_| StatusCode::UNAUTHORIZED)?;

        // Get user from database
        let user_id = Uuid::parse_str(&claims.sub)
            .map_err(|_| StatusCode::UNAUTHORIZED)?;

        let user = app_state.user_repository
            .find_by_id(user_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::UNAUTHORIZED)?;

        Ok(RequireAuth(user))
    }
}

impl<S> FromRequestParts<S> for OptionalAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);

        // Try to extract Authorization header
        let headers = &parts.headers;
        let token = match extract_token_from_headers(headers) {
            Some(token) => token,
            None => return Ok(OptionalAuth(None)),
        };

        // Try to validate JWT token
        let jwt_secret = std::env::var("JWT_SECRET")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        let claims = match validate_token(&token, &jwt_secret) {
            Ok(claims) => claims,
            Err(_) => return Ok(OptionalAuth(None)),
        };

        // Try to get user from database
        let user_id = match Uuid::parse_str(&claims.sub) {
            Ok(id) => id,
            Err(_) => return Ok(OptionalAuth(None)),
        };

        let user = app_state.user_repository
            .find_by_id(user_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        Ok(OptionalAuth(user))
    }
}

fn extract_token_from_headers(headers: &HeaderMap) -> Option<String> {
    let auth_header = headers.get("Authorization")?.to_str().ok()?;

    if auth_header.starts_with("Token ") {
        Some(auth_header[6..].to_string())
    } else {
        None
    }
}
```

Let me explain this piece of code, then we can continue understanding the entire middleware code:

```rust
impl<S> FromRequestParts<S> for RequireAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
```
### Breaking It Down Piece by Piece
**`impl<S>`** - Generic Implementation
- This says "I'm implementing something, and I have a generic type parameter called `S`"
- `S` can be any type - we don't know what it is yet
- Think of `S` as a placeholder: "whatever type the state happens to be"

**`FromRequestParts<S>`** - The Trait We're Implementing

- `FromRequestParts` is an Axum trait that lets you extract data from HTTP requests
- The `<S>` means "this trait works with some state type `S`"
- We're saying "our `RequireAuth` type can be extracted from requests that have state type `S`"

**`for RequireAuth`** - What We're Implementing For

- We're implementing this trait specifically for our `RequireAuth` struct
- After this implementation, you can use `RequireAuth` as a function parameter in handlers

**`where` clause** - The Constraints This is where we set rules about what `S` must be capable of:
```rust
where
    AppState: FromRef<S>,  // Rule 1
    S: Send + Sync,        // Rule 2
```

**Rule 1: `AppState: FromRef<S>`**
- This says "whatever type `S` is, we must be able to extract an `AppState` from it"
- In plain English this means "the state type must contain (or be convertible to) our `AppState`"
- This is what lets us do `let app_state = AppState::from_ref(state)` inside the implementation

**Rule 2: `S: Send + Sync`**
- `Send` means the type can be safely transferred between threads
- `Sync` means the type can be safely shared between threads
- These are required because Axum is async and multi-threaded

Ok, now lets continue. I generally don't explain code snippets like this but explained the above as I thought some readers might get confused about that.
### How Authentication Extractors Work

Axum extractors are functions that run before your handler and extract data from the request. Our auth extractors check for JWT tokens and give us the authenticated user.

When you use `RequireAuth` in a handler:

```rust
pub async fn protected_handler(RequireAuth(user): RequireAuth) -> String {
    format!("Hello, {}!", user.username)
}
```

Here's what happens behind the scenes:

1. The extractor extracts the Authorization header `Authorization: Token eyJ0eXAiOiJKV1Q...`
2. Then parse the token and remove "Token " prefix and get the JWT string
3. Validate the token and check signature with our secret key
4. Get user ID and extract user ID from token claims
5. Load user from database and find the user by ID
6. If everything works, handler gets the User object

If any step fails, the user gets a 401 Unauthorized response before your handler even runs.

### Authorization Header Format

We expect the client to send tokens in this exact format:

```
Authorization: Token eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
```

Our `extract_token_from_headers` function handles this parsing:
- It first get the `Authorization` header
- Then it does the parsing
```rust
if auth_header.starts_with("Token ") {
    Some(auth_header[6..].to_string())  // Skip "Token " (6 characters)
} else {
    None
}
```

### RequireAuth vs OptionalAuth

**RequireAuth** is for endpoints that need a logged-in user:

```rust
// User must be logged in, or they get 401 Unauthorized
pub async fn get_current_user(RequireAuth(user): RequireAuth) -> Json<UserResponse> {
    // We know 'user' is valid because RequireAuth validated the token
}
```

**OptionalAuth** is for endpoints that work for everyone but show extra info for logged-in users:

```rust
// Works for everyone, but logged-in users might see extra data
pub async fn get_article(OptionalAuth(maybe_user): OptionalAuth) -> Json<ArticleResponse> {
    match maybe_user {
        Some(user) => {
            // Show if this user has favorited the article
        },
        None => {
            // Show public article data only
        }
    }
}
```

### Database Lookup

You might wonder why we look up the user in the database when we already have their ID from the token.

Two reasons:
1. Token could be valid but user account was deleted
2. We want current username, bio, etc.

> By doing this, we are doing the same thing as session based auth, where we are doing db lookup per request. We could've skipped this and make it truely stateless jwt auth but for learning purposes, I thought I should keep the DB lookup. In future article, we might remove this.

```rust
let user = app_state.user_repository
    .find_by_id(user_id)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;  // None = user not found = unauthorized
```

If `find_by_id` returns `None`, it means the user doesn't exist anymore, so we reject the request even if the token is technically valid.

## Updating AppState for FromRef

We need to add `FromRef` to our `AppState` so the middleware can extract it.

Update `src/state.rs`:

```rust
use crate::repositories::UserRepository;
use axum::extract::FromRef;
use sqlx::PgPool;

#[derive(Clone, FromRef)]  // Add FromRef derive
pub struct AppState {
    pub db: PgPool,
    pub user_repository: UserRepository,
}

impl AppState {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let db = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations").run(&db).await?;
        let user_repository = UserRepository::new(db.clone());

        Ok(Self {
            db,
            user_repository,
        })
    }
}
```

Update `src/auth/mod.rs`:

```rust
pub mod password;
pub mod jwt;
pub mod middleware;
```



## Authentication Schemas

Before we build the handlers, we need to define the request and response structures for our authentication endpoints. These are the DTOs (Data Transfer Objects) that define what data flows in and out of our API. We already know about DTOs from previous article.

Create `src/schemas/auth_schemas.rs`:

```rust
use serde::{Deserialize, Serialize};
use validator::Validate;

#[derive(Debug, Deserialize)]
pub struct RegisterUserRequest {
    pub user: RegisterUserData,
}

#[derive(Debug, Deserialize, Validate)]
pub struct RegisterUserData {
    #[validate(length(min = 3, max = 50, message = "Username must be between 3 and 50 characters"))]
    pub username: String,

    #[validate(email(message = "Invalid email format"))]
    pub email: String,

    #[validate(length(min = 8, message = "Password must be at least 8 characters"))]
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginUserRequest {
    pub user: LoginUserData,
}

#[derive(Debug, Deserialize, Validate)]
pub struct LoginUserData {
    #[validate(email(message = "Invalid email format"))]
    pub email: String,

    #[validate(length(min = 1, message = "Password is required"))]
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct UserResponse {
    pub user: UserData,
}

#[derive(Debug, Serialize)]
pub struct UserData {
    pub email: String,
    pub token: String,
    pub username: String,
    pub bio: String,
    pub image: Option<String>,
}


impl UserData {
    pub fn from_user_with_token(user: crate::models::User, token: String) -> Self {
        Self {
            email: user.email,
            token,
            username: user.username,
            bio: user.bio.unwrap_or_default(), // Empty string if None
            image: user.image,                 // Keep as Option<String>
        }
    }
}
```


## Input Validation Rules

We're using the `validator` crate to check data before it hits our database.

**Username validation:**

```rust
#[validate(length(min = 3, max = 50, message = "Username must be between 3 and 50 characters"))]
pub username: String,
```

- Must be 3-50 characters
- Prevents empty usernames and extremely long ones

**Email validation:**

```rust
#[validate(email(message = "Invalid email format"))]
pub email: String,
```

- Must be a valid email format
- Uses regex to check for proper email structure

**Password validation:**

```rust
// For registration
#[validate(length(min = 8, message = "Password must be at least 8 characters"))]
pub password: String,

// For login
#[validate(length(min = 1, message = "Password is required"))]
pub password: String,
```

- Registration requires 8+ characters (basic security)
- Login just requires non-empty (we'll check against hash anyway)

## Why Separate Request and Data Structs?

You might wonder why we have both `RegisterUserRequest` and `RegisterUserData`. This follows the RealWorld API format where everything is wrapped:

```rust
// This handles the outer wrapper: { "user": { ... } }
#[derive(Debug, Deserialize)]
pub struct RegisterUserRequest {
    pub user: RegisterUserData,  // The actual data is inside
}

// This handles the inner data: { "username": "...", "email": "..." }
#[derive(Debug, Deserialize, Validate)]
pub struct RegisterUserData {
    // Validation happens here on the actual fields
}
```

When Axum deserializes the JSON, it matches this exact structure.

## Response Format Design

Our `UserResponse` always includes the JWT token along with user data:

```rust
#[derive(Debug, Serialize)]
pub struct UserData {
    pub email: String,
    pub token: String,        // Fresh JWT token
    pub username: String,
    pub bio: String,          // Empty string if None in database
    pub image: Option<String>, // null in JSON if None
}
```

**Key design decisions:**

- `bio` is always a string (empty if user has no bio)
- `image` can be null (follows JSON conventions)
- `token` is always included (client needs it for future requests)

## Converting from Database Models

We'll need a way to convert our database `User` model to the API response format.

```rust
impl UserData {
    pub fn from_user_with_token(user: crate::models::User, token: String) -> Self {
        Self {
            email: user.email,
            token,
            username: user.username,
            bio: user.bio.unwrap_or_default(), // Empty string if None
            image: user.image,                 // Keep as Option<String>
        }
    }
}
```

This helper function makes it easy to create API responses from database models:

```rust
let user_data = UserData::from_user_with_token(user, token);
let response = UserResponse { user: user_data };
```

Update `src/schemas/mod.rs`:

```rust
pub mod user_schemas;
pub mod auth_schemas;  // Add this line

pub use user_schemas::{CreateUserRequest, UpdateUserRequest, UserResponse};
pub use auth_schemas::*;  // Export all auth schemas
```




## Authentication Handlers

Now for the fun part, building the actual endpoints that handle registration, login, and getting current user data. This is where all our previous work pays off.

Create `src/handlers/auth.rs`:

```rust
use axum::{extract::State, http::StatusCode, Json};
use validator::Validate;
use crate::{
    auth::{
        password::{hash_password, verify_password},
        jwt::generate_token,
        middleware::RequireAuth,
    },
    schemas::auth_schemas::*,
    state::AppState,
};

pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterUserRequest>,
) -> Result<Json<UserResponse>, StatusCode> {
    // Validate input data
    payload.user.validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // Check if user already exists
    if state.user_repository
        .find_by_email(&payload.user.email)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Err(StatusCode::CONFLICT);
    }

    if state.user_repository
        .find_by_username(&payload.user.username)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some()
    {
        return Err(StatusCode::CONFLICT);
    }

    // Hash the password
    let password_hash = hash_password(&payload.user.password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Create user in database
    let user = state.user_repository
        .create(&payload.user.username, &payload.user.email, &password_hash)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Generate JWT token
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = generate_token(&user.id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Build response
    let user_data = UserData::from_user_with_token(user, token);
    let response = UserResponse { user: user_data };

    Ok(Json(response))
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginUserRequest>,
) -> Result<Json<UserResponse>, StatusCode> {
    // Validate input
    payload.user.validate()
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // Find user by email
    let user = state.user_repository
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

    // Generate JWT token
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = generate_token(&user.id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Build response
    let user_data = UserData::from_user_with_token(user, token);
    let response = UserResponse { user: user_data };

    Ok(Json(response))
}

pub async fn current_user(
    RequireAuth(user): RequireAuth,
) -> Result<Json<UserResponse>, StatusCode> {
    // Generate fresh JWT token
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = generate_token(&user.id, &jwt_secret)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Build response
    let user_data = UserData::from_user_with_token(user, token);
    let response = UserResponse { user: user_data };

    Ok(Json(response))
}
```

## Breaking Down the Registration Handler

Let me walk you through what happens when someone tries to register:

### Step 1: Validate Input
```rust
payload.user.validate()
    .map_err(|_| StatusCode::BAD_REQUEST)?;
```

This checks username length, email format, and password requirements. If validation fails, user gets a 400 Bad Request.

### Step 2: Check for Duplicates

```rust
// Check if user already exists
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
```

We check both email and username for uniqueness. If either exists, user gets a 409 Conflict.

### Step 3: Hash Password

```rust
let password_hash = hash_password(&payload.user.password)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
```

Then we are hashing the password as explained earlier.

### Step 4: Create User

```rust
let user = state.user_repository
    .create(&payload.user.username, &payload.user.email, &password_hash)
    .await?;
```

Insert the use data into database with hashed password. At this point, the user is registered but we are yet to sent a response with the access token to the user.

### Step 5: Generate Token

```rust
let token = generate_token(&user.id, &jwt_secret)?;
```

Create a JWT token so the user is immediately logged in after registration.

### Step 6: Build Response
```rust
let user_data = UserData::from_user_with_token(user, token);
let response = UserResponse { user: user_data };
```

Return user data with the access token

## Breaking Down the Login Handler

Login is simpler since the user already exists:

### Step 1: Find User

```rust
let user = state.user_repository
    .find_by_email(&payload.user.email)
    .await?
    .ok_or(StatusCode::UNAUTHORIZED)?;
```

If email doesn't exist, return 401 Unauthorized (don't reveal if email exists or not).

### Step 2: Verify Password

```rust
let password_valid = verify_password(&payload.user.password, &user.password_hash)?;
if !password_valid {
    return Err(StatusCode::UNAUTHORIZED);
}
```

Check password against stored hash. If wrong, return 401 Unauthorized.

### Step 3: Generate Access Token

```rust
let token = generate_token(&user.id, &jwt_secret)?;
```

Then we are generating a new access token for the user to login. Always generate a fresh token on login (better security than reusing old tokens).

## The Current User Handler - Simplest of All

```rust
pub async fn current_user(RequireAuth(user): RequireAuth) -> Result<Json<UserResponse>, StatusCode> {
```

Notice how simple this is? The `RequireAuth` middleware already:

- Extracted the JWT token
- Validated the signature
- Looked up the user in the database
- Rejected invalid tokens

By the time our handler runs, we know the user is authenticated and have their full data. We just generate a fresh token and return the user info.

> To get the current user details, obviously we need the current user to be logged in, otherwise how would we know who's the current user. Hence we are using the `RequireAuth` middleware instead of `OptionalAuth` middleware.

## Error Handling Strategy

We use different HTTP status codes for different error scenarios:

- **400 Bad Request**: Invalid input data (validation failed)
- **401 Unauthorized**: Wrong credentials or invalid/missing token
- **409 Conflict**: Trying to register with existing email/username
- **500 Internal Server Error**: Database errors, JWT secret missing, etc.

```rust
// Example error handling pattern:
.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
```

We convert all database errors to 500 Internal Server Error to avoid leaking implementation details to clients.

> In a future article, we will centralize this error handling and logging system


Update `src/handlers/mod.rs`:

```rust
pub mod health;
pub mod auth;  // Add this line
```

## Route Setup and Integration

Time to wire up our authentication system to the actual HTTP endpoints. This is where we add the routes to our existing server and see everything work together.

Update `src/main.rs`:

```rust
use axum::{routing::{get, post}, Router};
use std::env;

mod auth;
mod handlers;
mod models;
mod repositories;
mod schemas;
mod state;

use handlers::{
    health::health_check,
    auth::{register, login, current_user}
};
use state::AppState;

#[tokio::main]
async fn main() {
    // Load environment variables from .env file
    dotenvy::dotenv().ok();

    let database_url = env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set in .env file or environment");

    let app_state = AppState::new(&database_url)
        .await
        .expect("Failed to connect to database");

    println!("Connected to database successfully!");

    let app = Router::new()
        // Health check endpoint
        .route("/health", get(health_check))

        // Authentication endpoints
        .route("/api/users", post(register))
        .route("/api/users/login", post(login))
        .route("/api/user", get(current_user))

        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://localhost:3000");
    println!("Available endpoints:");
    println!("  POST /api/users         - Register new user");
    println!("  POST /api/users/login   - Login existing user");
    println!("  GET  /api/user          - Get current user (requires auth)");
    println!("  GET  /health            - Health check");

    axum::serve(listener, app).await.unwrap();
}
```

## Environment Configuration

Make sure your `.env` file has the JWT secret:

```env
DATABASE_URL=postgresql://username:password@localhost:5432/database_name
JWT_SECRET=your-super-secret-jwt-key-here-minimum-256-bits
```

**Important**: The JWT_SECRET should be at least 32 characters long and completely random. You can generate one by using the below command. Just run the command on your terminal:

```bash
# Generate a secure random key
openssl rand -base64 32
```

Or just use a long random string:

```
JWT_SECRET=kJ8mN9pQ2rS5tU7vW1xY3zA6bC4dE8fG0hI2jK5lM7nO9pQ2rS5tU7vW1xY3zA6
```


## API Routes
Our API now has a clean structure:
```
GET  /health              - Public health check
POST /api/users           - Public registration
POST /api/users/login     - Public login
GET  /api/user            - Protected current user info
```

Notice how we follow REST conventions:
- `POST /api/users` creates a new user (registration)
- `POST /api/users/login` is a special action on the users collection
- `GET /api/user` gets the current authenticated user (singular, because it's always "you")

## Testing the Complete Flow
Let's not test the complete authentication flow and wrap up this article.

Start your server:
```bash
cargo run
```

You should see:
```
Connected to database successfully!
Server running on http://localhost:3000
Available endpoints:
  POST /api/users         - Register new user
  POST /api/users/login   - Login existing user
  GET  /api/user          - Get current user (requires auth)
  GET  /health            - Health check
```

> To test the endpoint, you can use curl commands or tools like Postman, Hoppscotch, etc. I'll use Hoppscotch as its open source and lightweight.

### Register a new user
Let's try registering a user. Keep the request method as POST, use this url for registration: `http://localhost:3000/api/users` and put the user details in body as I've shown in the image.
![register_user.png](../../../assets/images/axum-backend-engineering/access-token/register.png)

You can see that we got our user details including the access token as response.

### Login with the same user
Now, lets try login with the user that we just registered.
![login.png](../../../assets/images/axum-backend-engineering/access-token/login.png)

You should see a successful response with the user details including the access token. We need this access token for future requests like requesting a protected route.

### Get current user
Now, lets try requesting the current user route, as this is a protected route only authenticated users can access this. Let's use the access token that we got from login request.

This time, you need to do a GET request to this endpoint `http://localhost:3000/api/user` and as I've shown in the image, put the access token in the headers tab with `Authorization` as key and `Token <YOUR_TOKEN>`.

> Remember, we need that word "Token " and then a single space, after that paste the access token.

![current_user.png](../../../assets/images/axum-backend-engineering/access-token/current_user.png)

You should be able to see the current user details. I know that in all 3 endpoints we are seeing the exact same thing but in future, as we will implement more features, we will clearly see more details and different details.

> Try changing the access token or email or username or password and you'll see you can't login or check current user. Try registering with same username or email and you'll get error.

### Overall Flow of Current User Endpoint
When you hit `GET /api/user` with a valid token:

1. **Axum routing** matches the request to our `current_user` handler
2. **RequireAuth extractor** runs before the handler:
    - Extracts "Authorization" header
    - Parses the JWT token
    - Validates signature with our secret
    - Looks up user in database
    - If anything fails, returns 401 before handler runs
3. **Handler runs** with authenticated user data
4. **Response sent** with fresh JWT token

The best part is that our handler code is super simple because all the authentication complexity is handled by the middleware.

## Conclusion
Awesome, we finished implementing our first and basic authentication layer. As planned, we will improve it incrementally. In the next post, first we will update our repositories to be a trait instead of struct and I'll explain why and then we will either implement refresh token or email verification and forget password feature. See you soon.
