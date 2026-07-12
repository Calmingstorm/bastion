# Bastion server — development tasks.
#
# Integration tests need a throwaway PostgreSQL and Redis. `make test` starts
# them in Docker, runs the suite, and leaves them running for fast re-runs; use
# `make test-down` to remove them.

TEST_PG_PORT ?= 5433
TEST_REDIS_PORT ?= 6380
export TEST_DATABASE_URL ?= postgres://bastion:bastion@localhost:$(TEST_PG_PORT)/postgres?sslmode=disable
export TEST_REDIS_ADDR ?= localhost:$(TEST_REDIS_PORT)

.PHONY: test test-race unit test-up test-down fmt fmt-check vet lint

## Run the full suite (integration + unit) against local test services.
## -count=1 disables Go's test result cache so integration tests always re-run.
test: test-up
	go test -count=1 ./...

## Run the full suite with the race detector.
test-race: test-up
	go test -race -count=1 ./...

## Run only the always-on unit tests (no services required).
unit:
	go test -short ./internal/permissions/... ./internal/auth/...

## Start throwaway PostgreSQL and Redis for integration tests.
test-up:
	@docker inspect bastion-test-pg >/dev/null 2>&1 || \
		docker run -d --name bastion-test-pg \
			-e POSTGRES_PASSWORD=bastion -e POSTGRES_USER=bastion -e POSTGRES_DB=postgres \
			-p $(TEST_PG_PORT):5432 postgres:16-alpine >/dev/null
	@docker inspect bastion-test-redis >/dev/null 2>&1 || \
		docker run -d --name bastion-test-redis -p $(TEST_REDIS_PORT):6379 redis:7-alpine >/dev/null
	@echo "waiting for postgres..."
	@until docker exec bastion-test-pg pg_isready -U bastion >/dev/null 2>&1; do sleep 1; done

## Remove the throwaway test services.
test-down:
	@docker rm -f bastion-test-pg bastion-test-redis >/dev/null 2>&1 || true

## Format all Go files in place.
fmt:
	gofmt -w .

## Fail if any Go file is not gofmt-formatted.
fmt-check:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "not formatted:"; echo "$$unformatted"; exit 1; fi

## Run go vet.
vet:
	go vet ./...

## Run golangci-lint.
lint:
	golangci-lint run ./...
