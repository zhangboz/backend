# Use the Node.js 20 base image
FROM node:20-bookworm

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install system dependencies: Pandoc and LaTeX for PDF generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-fonts-extra \ 
    texlive-xetex \
    && rm -rf /var/lib/apt/lists/*

# Copy package configuration files
COPY package*.json ./

# Install Node.js production dependencies
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Tell Docker which port the app will run on
EXPOSE 5000

# Define the command to start the app
CMD [ "node", "server.mjs" ]