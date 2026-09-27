ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=4398 DATA_DIR=/data
EXPOSE 4398
CMD ["npm", "start"]
