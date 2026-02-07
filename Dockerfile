# Base image
FROM node:24-alpine

# Install ffmpeg for audio processing and wget for healthcheck
RUN apk add --no-cache ffmpeg wget

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including TypeScript for build)
RUN npm ci

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies and source files to reduce image size
RUN rm -rf src node_modules && \
    npm ci --only=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Ensure data directory exists and set permissions
RUN mkdir -p /data && \
    chown -R nodejs:nodejs /app /data

# Switch to non-root user
USER nodejs

# Expose application port
EXPOSE 8080

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
