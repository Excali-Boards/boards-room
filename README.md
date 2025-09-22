# 🧠 Boards Room (Backend)

**Boards Room** is the real-time backend service powering collaborative drawing sessions around [Excalidraw](https://github.com/excalidraw/excalidraw). It supports user access control, persistent board storage via PostgreSQL, and file uploads via S3.

---

## ✅ Features

- ⚡ Real-time collaboration using Socket.IO
- 🧑‍🤝‍🧑 Board grouping, permissions, and user roles
- 🔗 Invite users to boards with unique links
- ☁️ File upload and storage with S3
- 🗃️ Persistent board data using PostgreSQL
- 🔐 API and WebSocket authentication with API tokens

---

## ⚙️ Setup

### 1. Clone the repo

```bash
git clone https://github.com/Excali-Boards/boards-room.git
cd boards-room
pnpm install
```

### 2. Configure environment

Create a `.env` file with the following variables:

```env
# Allowed Origins
ALLOWED_ORIGINS="http://localhost:3002"

# API Auth
API_TOKEN="your-api-token"           # Shared token with frontend
DEVELOPERS="admin@example.com"       # Comma-separated admin user emails

# Server Settings
PORT=3004
DATABASE_URL="your-database-url"

# S3 Storage
S3_ENDPOINT="https://s3.example.com"
S3_ACCESS_KEY="your-access-key"
S3_SECRET_KEY="your-secret-key"
S3_BUCKET="your-bucket-name"
```

> 🔐 **Note:** The `API_TOKEN` is required for all communication between frontend and backend. Keep it secret.

### 3. Run the server

```bash
pnpm run rebuild
```

Backend runs at `http://localhost:3004`.

---

## 🤝 Contributing

Contributions, fixes, and ideas are welcome! If you'd like to get involved:

- Fork the repository and make your changes.
- Run `pnpm lint && pnpm typecheck` before pushing.
- Open a pull request with a clear description.

Please follow the existing coding style and commit clean, atomic changes.

---

## 💬 Support

Questions, issues, or just want to chat? Join our community on **Discord**:
👉 [https://discord.gg/4rphpersCa](https://discord.gg/4rphpersCa)

---

## 📜 License

[GNU General Public License v3.0](./LICENSE)
