ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 4399
CMD ["npm", "start"]
