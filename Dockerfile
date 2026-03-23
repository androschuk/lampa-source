# ----- Build stage -----
FROM node:25-alpine AS build

WORKDIR /app

# Copy package manifest first to leverage Docker cache for npm install
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --no-audit --no-fund

# Copy source and run production build (matches `build:prod`)
COPY . .
RUN npx gulp build_all --uglifyJs --uglifyCss

# ----- Production stage -----
FROM nginx:1.29-alpine

# Copy built web output (adjust if you want to serve another platform)
COPY --from=build /app/build/web /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
