---
title: "Building a Coding Agent in Rust: Introduction"
description: "Setting up the coding agent rust project with Gemini API"
pubDatetime: 2025-10-26T19:30:00Z
tags: ["rust", "agent", "ai", "gemini"]
series: "Building a Coding Agent in Rust"
seriesOrder: 1
featured: true
ogImage: ../../../assets/images/coding-agent/introduction/coding-agent-project-setup.png
---

<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 700px; margin: 0 auto;">
  <iframe
    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"
    src="https://www.youtube.com/embed/tQJTuYkZ4u8?si=oWmSPxLYynM4f-EX"
    title="YouTube video player"
    frameborder="0"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen>
  </iframe>
</div>

In this series, we'll build our own coding agent from scratch completely in Rust and Gemini API.

This is more of an experimental series rather than a definitive series. So, instead of trying to implement the best possible coding agent architecture, we will go step by step improving slowly and steadily.

Get the source code from here --> https://github.com/0xshadow-dev/coding-agent

We are building a coding agent CLI like claude code or gemini CLI.

> I won't dump a bunch of theory at once, instead this will be very hands on series and I'll explain the concepts or introduce concepts as and when needed.




## Why Build it Yourself?
Because building from scratch helps me to learn the under the hood concepts and their different approaches, architectures and trade offs.

For me, this is the best way to learn something. If I want to understand about building a ai agent, I'll build it from scratch to understand its architectures and design decisions.

I'm a frequent user of claude code and sometimes tried other coding agents, hence I decided to learn about it by building one for myself and explain my learnings with you guys.

## The Tentative Roadmap
For now, I know that these are the things that I'll implement to build my coding agent steadily:
- We set up the project properly.
- We build the core agent loop.
- We add the tool system.
- We build actual tools.
After this, I don't know what direction I'll go but no matter what, it'll be fun and exciting.
## Prerequisites
I'm assuming you know Rust. You should be comfortable with:
- Ownership and borrowing (the basics)
- Traits and implementations
- Async/await (at least conceptually)
- Using Cargo and managing dependencies

If you've built a simple HTTP server in Rust, you're fine.

I'm also assuming you've used LLMs before. Like, you've played with ChatGPT or Claude. You don't need to know how transformers work or anything as we're using APIs, not training models.

Everything else? I'll explain as we go.

## Project Setup
Let's start by setting up our project using `cargo`.

### Create the Project
Open your terminal and run:
```bash
cargo new coding-agent
cd coding-agent
```

Now, if you'll open up this project in your preferred editor then you can see the folder structure like this:
```bash
├── Cargo.toml
└── src
    └── main.rs
```

This is a standard new cargo project structure. This is our starting point.

### Adding Dependencies
Before giving you the entire `Cargo.toml`, let me explain what we actually need and why.

We are building an agent that:
- makes HTTP calls to Gemini (async I/O)
- needs to parse JSON (requests/responses)
- will do multiple things at once (parallel tool execution, not an immediate requirement)
- needs good error messages (for debugging)
- has to load api keys (environment variables)
That means we need:
- an async runtime
- an HTTP client
- JSON serialization
- error handling
- environment variable loading

Let's add them one by one so you understand what each does.

Open `Cargo.toml` and replace everything with this:
```toml
[package]
name = "ai-coding-agent"
version = "0.1.0"
edition = "2024"

[dependencies]
# Async runtime
tokio = { version = "1.42", features = ["full"] }

# HTTP client
reqwest = { version = "0.12", features = ["json"] }

# JSON handling
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# Error handling
anyhow = "1.0"

# Async traits (we'll need this later)
async-trait = "0.1"

# Environment variables
dotenvy = "0.15"
```

> I'm using 2024 edition but if you are using 2021 edition, then instead of writing 2024 write 2021.

### Create the .env File
Create a .env file in your project root:
```bash
touch .env
```

Open it and add:
```env
GEMINI_API_KEY=your-api-key-goes-here
```

If you don't have an API key yet, then do this to get one:
- Go to [https://aistudio.google.com](https://aistudio.google.com)
- Sign in with your Google account
- Click **"Create API Key"**
- Copy the key
- Paste it in your `.env` file

> We are using gemini because of its good enough free tier.

### Add .env to gitIgnore
This is IMPORTANT. Never commit your `.env` file.

Open `.gitignore` (cargo created this for you) and make sure it includes:
```gitignore
/target
.env
```

The `.env` line prevents you from accidentally committing your API key to GitHub.

### Main Function
Now let's write the simplest possible program to verify everything works.

Open `src/main.rs` and replace it with:
```rust
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    // Load environment variables from .env
    dotenvy::dotenv().ok();

    // Get the API key
    let api_key = std::env::var("GEMINI_API_KEY")?;

    println!("✓ Environment loaded");
    println!("✓ API key found: {}...", &api_key[..20]);
    println!("✓ Async runtime working");

    Ok(())
}
```

Let me explain this briefly:
We are using `#[tokio::main]` macro  to setup tokio async runtime. Then we are making our main function async.

Inside main, first we are getting our api key. This reads the `GEMINI_API_KEY` environment variable. The `?` means "if it doesn't exist, return an error." If you forgot to create the `.env` file or didn't set the key, you'll get a nice error: ` Error: environment variable not found`

Finally, just printing some basic stuff, to know that everything is working perfectly fine.

### Run It
Run the following command to run the project:
```bash
cargo run
```

You should an output like this:
```bash
Environment loaded
API KEY FOUND
Async runtime working
```

## Conclusion
Awesome, we finished setting up our project and understood what are we going to build in this series. I kept this article very small because I don't want to overwhelm anyone with tons of info.

In the next article, we will build the agent's loop and integrate gemini api and after that we will start building and integrating tools.

I'm really excited for this. See you soon!
