# Choose a base Node.js image
FROM node:20-bookworm

# Set a working directory in the container
WORKDIR /usr/src/app

# --- Install System Dependencies ---
# Update package lists and install Pandoc and a TeX Live distribution for PDF generation.
# 'no-install-recommends' helps keep the image size smaller.
# We need 'texlive-xetex' because your code specifies '--pdf-engine=xelatex'.
# We need 'texlive-latex-extra' for packages like 'xcolor' used by '-V colorlinks'.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc \
    # ---- For PDF Generation ----
    texlive-latex-base \
    texlive-fonts-recommended \
    texlive-latex-extra \
    texlive-xetex \
    # ---- End PDF Packages ----
    # Clean up apt cache to reduce image size in this layer
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies for production
RUN npm ci --omit=dev

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 5000

# Define the command to run your application
# Ensure this path is correct for your project structure
CMD [ "node", "backend/server.mjs" ]