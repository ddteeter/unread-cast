# Build stage
FROM node:24-alpine AS builder

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

# Production stage
FROM node:24-alpine

# Install ffmpeg for audio processing and wget for healthcheck
RUN apk add --no-cache ffmpeg wget

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy default pricing config into the image
COPY data/pricing.json.example /app/pricing.json

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
