FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies (cache package.json separately)
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Ensure uploads directory exists
RUN mkdir -p public/uploads && chown -R node:node public/uploads

USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
