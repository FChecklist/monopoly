# Registry note: product code MON

- Product: office floor game (the name is one config string; code name `floor`).
- Code: MON (product code). Folder and repository names are infrastructure names chosen by the owner.
- Host: a Cloudflare Pages project and a D1 database (names in wrangler.toml only). Domain: a subdomain chosen by the owner, one DNS record.
- Own database, accounts, login, admin and deploy. Shares nothing with other products.
- Talks to Corporate Moneypenny ONLY through src/provider (one adapter). Stores no credit balances.
- Borders: CONTRACT/ (provider-v1, signed-v1, examples).
- Not live: no company may hold real data until Moneypenny is live and test/contract-live.test.js passes.
- Risk: a word in infrastructure names (wrangler.toml) may be a third-party trademark. The product name is one config string; the domain is one DNS record the owner can change.
