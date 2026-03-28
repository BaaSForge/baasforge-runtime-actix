## To fix libpg issue (library not found)

[GPT Conversation](https://chatgpt.com/share/698ccc50-aea8-800e-b2d2-fb27cb695f0d)

```sh
brew install postgresql
brew install libpq
brew link --force libpq
```

```sh
cargo clean
cargo build
```

Add this to ~/.cargo/config.toml:
```toml
[env]
LIBRARY_PATH = "/opt/homebrew/opt/libpq/lib"
```
(Use `brew --prefix libpq` to get correct path)
