.DEFAULT_GOAL := help

.PHONY: help install build start up stop down restart status logs ui router-console \
	storage-1-console storage-2-console reset api api-watch examples test typecheck lua-typecheck

help:
	@echo "Tarantool vshard learning cluster"
	@echo "  make start       Build, start, and wait for a healthy cluster"
	@echo "  make stop        Stop the cluster"
	@echo "  make restart     Restart the cluster"
	@echo "  make status      Show container health"
	@echo "  make logs        Follow cluster logs"
	@echo "  make ui          Print community UI address and connection details"
	@echo "  make api         Start the Effect v4 + Better Auth HTTP API"
	@echo "  make api-watch   Start the HTTP API with file watching"
	@echo "  make test        Run the live Bun smoke test"
	@echo "  make examples    Run all TypeScript examples"
	@echo "  make typecheck   Run TypeScript and Lua static checks"
	@echo "  make reset       Stop and permanently delete Docker database volumes"

install:
	bun install

build:
	docker compose build

start:
	docker compose up --build --detach --wait
	@echo "Tarantool router is ready at 127.0.0.1:3301"

up: start

stop:
	docker compose down

down: stop

restart: stop start

status:
	docker compose ps

logs:
	docker compose logs -f

ui:
	@echo "Community Tarantool Admin: http://localhost:8000"
	@echo "Router:    router:3301    user app       password app-secret"
	@echo "Router 2:  router-2:3301  user app       password app-secret"
	@echo "Storage 1: storage-1:3301 user storage   password storage-secret"
	@echo "Storage 2: storage-2:3301 user storage   password storage-secret"

api:
	bun run server

api-watch:
	bun run server:watch

router-console:
	docker compose exec router console

storage-1-console:
	docker compose exec storage-1 console

storage-2-console:
	docker compose exec storage-2 console

reset:
	docker compose down -v

examples:
	bun run example:all

test:
	bun test

typecheck:
	bun run typecheck
	$(MAKE) lua-typecheck

lua-typecheck:
	@command -v lua-language-server >/dev/null || { \
		echo "lua-language-server is required for Lua type checking" >&2; \
		echo "Install LuaLS, then rerun make lua-typecheck" >&2; \
		exit 127; \
	}
	lua-language-server --check=$(CURDIR) --checklevel=Warning
