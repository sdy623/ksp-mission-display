.DEFAULT_GOAL := help

NPM ?= npm.cmd
POWERSHELL ?= powershell

.PHONY: help setup dev dev-lan fake-backend lint test test-python test-node test-e2e web backend package release release-fast

help:
	@echo KSP Mission Display build targets
	@echo
	@echo   make setup         Install the locked Node dependencies
	@echo   make dev           Start the local web development server
	@echo   make dev-lan       Start the LAN development server on port 3013
	@echo   make fake-backend  Start deterministic REST/WebSocket telemetry
	@echo   make lint          Run the frontend static checks
	@echo   make test          Run Python, Node, integration, and browser tests
	@echo   make web           Build the standalone web application
	@echo   make backend       Freeze the Python kRPC backend
	@echo   make package       Build Electron packages with existing inputs
	@echo   make release       Run the complete verified Windows release build
	@echo   make release-fast  Rebuild packages without install or test steps

setup:
	$(NPM) ci

dev:
	$(NPM) run dev -- --port 3011

dev-lan:
	$(NPM) run dev:lan

fake-backend:
	$(NPM) run fake-backend

lint:
	$(NPM) run lint

test:
	$(NPM) run test:all

test-python:
	$(NPM) run test:python

test-node:
	$(NPM) run test:node

test-e2e:
	$(NPM) run test:e2e

web:
	$(NPM) run build

backend:
	$(NPM) run backend:bundle

package:
	$(NPM) run electron:dist

release:
	$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File .\build.ps1

release-fast:
	$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -SkipDependencyInstall -SkipTests
