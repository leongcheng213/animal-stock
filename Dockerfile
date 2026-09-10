# Animal Stock — no dependencies, Python stdlib only.
FROM python:3.12-slim
WORKDIR /srv/game
COPY server.py ./
COPY shared/ ./shared/
COPY client/ ./client/
EXPOSE 8000
# PORT is provided by the host (Render/Railway/Fly); server.py reads it.
CMD ["python", "server.py"]
