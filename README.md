frcScoutingApp

## Combined web server and livestream worker

See [docs/SERVER.md](docs/SERVER.md) for the JSON configuration, automatic
livestream launch, web UI controls, and Linux systemd setup.

For a compact guide to using the app itself, see
[docs/APP_QUICKSTART.md](docs/APP_QUICKSTART.md).

## The Blue Alliance API key

This app can fetch events and matches from The Blue Alliance (TBA). To enable live TBA queries, provide your TBA API key as a Vite environment variable named `VITE_TBA_API_KEY`.

Local development:

- Create a file named `.env.local` in the project root and add:

```env
VITE_TBA_API_KEY=your_tba_api_key_here
```

- Restart the dev server (`npm run dev`) so Vite picks up the new env.

CI / Production builds:

- Add the key to your repository secrets (for example `TBA_API_KEY`) and map it to `VITE_TBA_API_KEY` in your CI build step so Vite can inline it at build time. For GitHub Actions, set `VITE_TBA_API_KEY: ${{ secrets.TBA_API_KEY }}` in the workflow environment for the build step.

If no key is provided, the Match Selection UI will fall back to local/mock behavior and will not be able to fetch live events from TBA.
