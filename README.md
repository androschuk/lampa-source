# Lampa
Forked from [yumata/lampa-source](https://github.com/yumata/lampa-source)

## Install & Run

```bash
git clone https://github.com/androschuk/lampa-source.git
cd lampa-source
npm install
npm run start
```

## Run with Docker

This project includes a multi-stage Dockerfile and a `docker-compose.yml` to build the application and serve the built static files with nginx.

### Build and start (production)

```bash
# Build image and run container
docker compose build
docker compose up -d
```

After the container is up, open your browser and navigate to:

`http://localhost:8080`

(Adjust the host port if you changed `docker-compose.yml`.)

### Run the prebuilt image from Docker Hub

A prebuilt production image is available on Docker Hub: https://hub.docker.com/r/androschuk/lampa

You can run it directly:

```bash
docker run -d \
  --name lampa \
  --restart unless-stopped \
  -p 8080:80 \
  androschuk/lampa
```

### Stop and remove containers

```bash
docker compose down
```

### Verify and troubleshooting

- View container logs: `docker compose logs -f`
- Check that the built files are present in the container: `docker compose exec lampa ls -la /usr/share/nginx/html`
- If you changed ports in `docker-compose.yml`, use the mapped host port instead of `8080`.

## Documentation

Internal documentation can be generated locally:
```bash
npm run doc
```
AI documentation  [![DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/androschuk/lampa-source)


## Upgrade to Version 3.0

Version 3.0 introduces significant changes to the project structure and codebase. Please refer to the [migration guide](UPGRADE.md)
 to learn how to update your application to the new version.
