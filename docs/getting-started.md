# Getting started

This page gets the console running on your machine and signs you in for the first time.

## What you need

- **Node.js 20 or later.**
- **MySQL 8** (or MariaDB) for a real installation. For a first look you can use SQLite instead, with no database server.
- **Docker** later, when you want to run a gateway on your machine (see [Run a gateway](tutorials/04-run-a-gateway.md)).

## Install

```bash
git clone <your repository URL> oauth-server
cd oauth-server
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a long random string, for example the output of:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

The console refuses to start without it. It signs session tokens with it and, unless you set `PKI_MASTER_KEY`, also derives the key that seals stored private keys from it. Don't change it once gateways are set up. See [Configuration](guides/configuration.md).

## Option A: try it on SQLite

```bash
npm run dev:sqlite
```

This runs the console on `./dev.sqlite` and seeds two accounts on the first run:

| Email | Password | Role |
|---|---|---|
| `admin@example.com` | `admin12345` | Platform admin |
| `dev@example.com` | `dev12345` | User |

Use these only on your machine.

## Option B: run on MySQL

1. Create an empty database and a user for it:

   ```sql
   CREATE DATABASE newday CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'oauth'@'localhost' IDENTIFIED BY 'a-strong-password';
   GRANT ALL PRIVILEGES ON newday.* TO 'oauth'@'localhost';
   ```

2. Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` in `.env`.
3. Start the console:

   ```bash
   npm start          # or: npm run dev, which restarts on changes
   ```

On the first start the console creates its tables. Later schema changes are applied with `npm run migrate-data` (see [Operations](guides/operations.md#schema-and-data-migrations)).

The console stops with a message if `JWT_SECRET` is missing, if the database can't be reached, or if port 3000 is already in use. To use another port, set `PORT`.

## Sign in

Open <http://localhost:3000>.

- **Register** to create an account. Registering also creates an organization with you as its admin, so you can start publishing straight away.
- Or **sign in** with one of the seeded accounts on SQLite.

The dashboard shows a setup checklist for your organization and offers a short tour of the console. You can take the tour of any page later with the **?** button in the header.

## Next steps

- Read [Concepts](concepts.md) for how organizations, catalogs, products, applications and gateways relate.
- Follow [Publish your first API](tutorials/01-publish-your-first-api.md).
