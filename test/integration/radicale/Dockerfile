FROM python:3.13.14-alpine3.24@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0

LABEL io.n8n-nodes-caldav.radicale-version="3.7.7"
LABEL io.n8n-nodes-caldav.python-base="python:3.13.14-alpine3.24@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0"

RUN python -m pip install --no-cache-dir Radicale==3.7.7

RUN addgroup -S -g 10001 radicale \
	&& adduser -S -D -H -u 10001 -G radicale radicale \
	&& mkdir -p /var/lib/radicale/storage \
	&& chown -R radicale:radicale /var/lib/radicale

USER 10001:10001
WORKDIR /var/lib/radicale

EXPOSE 5232

CMD ["python", "-m", "radicale", "--version"]
