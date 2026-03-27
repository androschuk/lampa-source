# Gemini CLI - Lampa Project Context

This file provides context and instructions for Gemini CLI when working on the Lampa project.

## Project Overview

**Lampa** is a modular application for viewing content, designed to run on various platforms including Web, LG WebOS, Samsung Tizen, and as a static site (GitHub Pages). It features a highly flexible architecture that supports plugins and extensions.

### Core Technologies
- **Language:** JavaScript (ES Modules)
- **Build System:** Gulp, Rollup, esbuild
- **Styling:** Sass (compiled to CSS)
- **Testing:** Vitest
- **Linting:** ESLint
- **Runtime Environments:** Web Browsers, Smart TVs (WebOS, Tizen)

### Architecture (Version 3.0+)
The project uses a modular class system centered around `Lampa.Maker`.
- **`Lampa.Maker`**: The central factory for creating and extending classes (e.g., `Card`, `Main`, `Line`, `Episode`).
- **Modules**: Classes are composed of modules that define specific behaviors (e.g., `Create`, `Callback`, `Style`, `Items`).
- **`MaskHelper`**: Used to manage sets of modules (masks).
- **Entry Point**: `src/app.js` initializes the global `Lampa` object and bootstraps the application.
- **Global Object**: Most core functionality is exposed via the global `window.Lampa` object.

## Building and Running

### Development
```bash
# Install dependencies
npm install

# Start development server with live reload (BrowserSync)
npm run start
```

### Production Build
```bash
# Build for all platforms
npm run build:all

# Build for specific platforms
npm run build:web
npm run build:webos
npm run build:tizen
npm run build:github

# Build plugins only
npm run build:plugins
```

### Testing and Linting
```bash
# Run tests
npm run test

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix
```

### Documentation
```bash
# Generate internal documentation from @doc tags
npm run build:doc
```

## Development Conventions

### Modular Classes
When adding or modifying components, adhere to the v3.0 modular structure. Use `Lampa.Maker.make` to instantiate classes and `Lampa.Maker.module` to customize them.

Example of creating a customized card:
```javascript
let card = Lampa.Maker.make('Card', { title: 'Example' }, (module) => module.only('Create', 'Callback'));
card.use({
    onEnter: () => { /* action */ }
});
```

### File Structure
- `src/core/`: Core logic, manifest, language, storage, and service management.
- `src/interaction/`: UI components, controllers, activity management, and the `Maker`.
- `src/utils/`: Helper functions, constants, and utilities.
- `plugins/`: Independent plugin source code.
- `index/`: Platform-specific HTML entry points and loaders.
- `public/`: Static assets (images, fonts, sounds).

### Coding Style
- Follow ESM (ECMAScript Modules) standards.
- Use JSDoc with `@doc`, `@name`, and `@alias` tags for documentation.
- Maintain compatibility with older TV browsers (ES2017 target is used in the build).
- Avoid direct DOM manipulation where `Lampa.Template` or modular components can be used.

### Testing
- Add new tests in the `spec/` directory using Vitest.
- Ensure existing tests pass before submitting changes.

## Security & Safety
- **Secrets**: Never commit API keys or sensitive configurations. Use `window.lampa_settings` for configuration but keep environment-specific secrets out of source control.
- **Source Control**: Do not stage or commit changes unless explicitly requested.

## Git Workflow

- **Branch Creation**:
  - Before creating a new branch, always ensure your local `main` is up to date:
    ```bash
    git checkout main
    git pull
    ```
  - If you have uncommitted changes that conflict with `pull`:
    1. `git stash` (save changes)
    2. `git pull` (update main)
    3. `git stash pop` (restore changes and resolve conflicts)
  - **Efficient Method**: To update local `main` without switching branches:
    ```bash
    git fetch origin main:main
    ```
    Then rebase or merge your current branch if needed.

- **Branch Naming**:
  - Features: `feature/short-description`
  - Bug fixes: `fix/short-description`
  - Documentation: `docs/short-description`
- **Commit Messages**:
  - Use Conventional Commits format (e.g., `feature: add new player component`).
  - Keep messages concise and descriptive.
- **Pull Requests**:
  - Always create a new branch for changes.
  - Provide a clear summary of changes and benefits in the PR description.
  - Reference issues if applicable (e.g., `closes #123`).
