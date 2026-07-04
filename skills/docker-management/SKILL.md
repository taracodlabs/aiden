---
name: docker-management
description: Docker containers, images, volumes, networks (CLI + Dockerode)
category: developer
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: docker, containers, images, volumes, networks, compose, dockerode, devops, deployment
metadata:
  aiden:
    required_binaries:
      - name: docker
        help: Install Docker Desktop / Engine — https://docs.docker.com/get-docker/
---

# Docker Container Management

Manage Docker containers, images, volumes, and networks using the Docker CLI or Dockerode (Node.js Docker API client already in DevOS).

## When to Use

- User wants to list running or stopped containers
- User wants to start, stop, or restart a container
- User wants to pull, build, or remove Docker images
- User wants to view container logs
- User wants to inspect container resource usage

## How to Use

### 1. List containers

```powershell
# Running containers
docker ps

# All containers including stopped
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"
```

### 2. Start, stop, and restart containers

```powershell
docker start  my-container
docker stop   my-container
docker restart my-container

# Stop all running containers
docker stop $(docker ps -q)
```

### 3. View container logs

```powershell
# Last 100 lines
docker logs my-container --tail 100

# Follow live output
docker logs my-container --follow --tail 50
```

### 4. Manage images

```powershell
# List images
docker images

# Pull latest image
docker pull nginx:latest

# Remove image
docker rmi nginx:latest

# Build from Dockerfile in current directory
docker build -t my-app:v1 .
```

### 5. Container resource usage

```powershell
# Live resource stats (CPU, memory, network)
docker stats --no-stream

# Inspect a specific container
docker inspect my-container | python -m json.tool
```

### 6. Manage volumes and networks

```powershell
# List volumes
docker volume ls

# List networks
docker network ls

# Remove unused volumes (reclaim disk)
docker volume prune -f

# Remove stopped containers, unused images, and networks
docker system prune -f
```

### 7. Execute commands inside a container

```powershell
# Interactive shell
docker exec -it my-container /bin/bash

# Run a single command
docker exec my-container cat /etc/nginx/nginx.conf
```

### 8. Docker Compose operations

```powershell
# Start all services defined in docker-compose.yml
docker compose up -d

# View logs for all services
docker compose logs -f

# Stop and remove containers
docker compose down

# Rebuild and restart a specific service
docker compose up -d --build api
```

### 9. Use Dockerode API (Node.js)

```javascript
// Already available in DevOS dependencies
const Dockerode = require('dockerode')
const docker    = new Dockerode()

const containers = await docker.listContainers({ all: true })
containers.forEach(c => console.log(c.Names[0], c.State, c.Image))

const container = docker.getContainer('my-container')
await container.restart()
console.log('Restarted')
```

## Examples

**"Show me all running containers and their ports"**
→ Use step 1 with `docker ps` and the format string.

**"The nginx container seems slow — show me its CPU and memory usage"**
→ Use step 5 with `docker stats --no-stream` filtered to the nginx container.

**"Rebuild and restart the API service after my code change"**
→ Use step 8: `docker compose up -d --build api`.

## Cautions

- `docker system prune` removes ALL stopped containers, unused images, and networks — confirm with the user first
- `docker stop $(docker ps -q)` stops ALL running containers — confirm which containers to stop
- Bind mounts expose host filesystem paths to containers — check paths before mounting
- For production deployments, prefer `docker compose` or Kubernetes over direct `docker run` commands
- Container logs can grow very large — use `--tail` to limit output for inspection
