# Rollback

Keep the ids from the record at the end of DEPLOY.md at hand. No secrets belong in this file.
Rule of thumb: stop the damage first (AI switch, key revoke, previous deployment), then repair data.

## 1. A bad release (Pages)
1. Cloudflare dashboard > Workers & Pages > the project > Deployments.
2. Pick the last good deployment > "Rollback to this deployment". The page and the functions both go back.
3. From the command line: `npx wrangler pages deployment list --project-name <project-name>` to see ids. Redeploying an older commit also works.
4. Run the smoke test in DEPLOY.md section 6.
5. A rollback never changes the database. If the bad release wrote bad data, continue with section 2.

## 2. Bad or lost data (D1)
1. Pause writes first: roll the site back (section 1) or put the company in read-only by switching its keys off (section 4).
2. D1 time travel restores a database to any minute in the last 30 days:
   * `npx wrangler d1 time-travel info <database-name>` shows the current bookmark.
   * `npx wrangler d1 time-travel restore <database-name> --timestamp <iso-time-before-the-problem>` (or `--bookmark <id>`).
   * Note the bookmark printed BEFORE restoring: it is the undo for the restore.
3. A restore also removes good writes made after that time. Tell the people who entered events since then.
4. The audit trail is hash-chained: after any restore, run the audit check in Admin > HR desk > Audit trail and keep the result.
5. To start over from nothing: export what you need, create a new database, apply migrations in order, point `wrangler.toml` at it, redeploy.

## 3. A wrong DNS record
1. At the DNS host delete the CNAME for the product hostname (or set it back to its previous value from the record).
2. In Pages > Custom domains remove the hostname.
3. The product stays reachable at `<project-name>.pages.dev` unless you also pause the project.

## 4. A leaked or misused key
1. Admin > Connections > "Switch a key off" with the key id. The system using it stops at once.
2. Create a new key, give the secret to the owner of that system through a safe channel, and update their settings.
3. Provider credentials: revoke in the provider's own console, then set new ones as Pages secrets and redeploy.
4. If `MASTER_SECRET` may have leaked: follow the rotation steps below, then revoke every key.
   * Add the new secret under a new version tag, keep the old one only while sealed data is re-sealed, then remove the old one.
   * People who sign in need new codes after a rotation.

## 5. AI kill switch
1. Admin > AI access > "Switch AI off". All AI use for the company stops at once. Pending requests stay pending.
2. Deeper stop: switch off every key whose class is AI (section 4) and remove the AI secret from the Pages secrets.
3. To bring it back, switch AI on again and check each key's class first.

## 6. After any rollback
* Write what happened, what was restored, and who was told.
* Re-run `npm test`, the word scan and the secret scan before the next deploy.
