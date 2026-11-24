FROM node:22-bookworm-slim AS frontend

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY public/ public/
COPY src/ src/
RUN VITE_API_BASE_URL=/exam-scanner/backend/api npm run build

FROM php:8.4-apache-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends apache2-utils mariadb-server \
    && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install pdo_mysql \
    && a2enmod headers rewrite \
    && printf 'Listen 10000\n' > /etc/apache2/ports.conf \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

COPY --from=frontend /build/dist/ /var/www/html/exam-scanner/dist/
COPY backend/api/ /opt/exam-scanner/api/
COPY backend/sql/schema.sql /opt/exam-scanner/schema.sql
COPY deploy/render/api-router.php /var/www/html/exam-scanner/backend/api/index.php
COPY deploy/render/apache.conf /etc/apache2/sites-available/000-default.conf
COPY --chmod=755 deploy/render/start-preview.sh /usr/local/bin/start-preview

EXPOSE 10000
CMD ["start-preview"]
