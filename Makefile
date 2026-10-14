.PHONY: install check run

install:
	uv sync

check:
	uv run python check.py

run:
	uv run claim-server
