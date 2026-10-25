services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_USER: kendy, POSTGRES_PASSWORD: kendy, POSTGRES_DB: kendy }
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["5432:5432"]
  backend:
    build: { context: ., dockerfile: docker/backend.Dockerfile }
    env_file: .env
    depends_on: [postgres]
    ports: ["3000:3000"]
    volumes: [apkdata:/data]
volumes: { pgdata: {}, apkdata: {} }
