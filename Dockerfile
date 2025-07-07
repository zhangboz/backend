# Use the Node.js 20 base image
FROM node:20-bookworm

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install system dependencies needed for file conversion.
# This includes Pandoc and a full TeX Live distribution for PDF generation.
RUN apt-get update && apt-get install -y \
    pandoc \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-fonts-extra \
    texlive-xetex \
    && mktexlsr \
    && rm -rf /var/lib/apt/lists/*

# Copy package configuration files
COPY package*.json ./

# Install Node.js production dependencies
# This will install express, bullmq, etc.
RUN npm ci --omit=dev

# Copy the rest of the application code (including your worker.mjs)
COPY . .

# Tell Docker which port the app might run on (not strictly needed for a worker, but good practice)
EXPOSE 5000

# Define the command to start the WORKER process using the npm script.
CMD [ "npm", "run", "start:worker" ]