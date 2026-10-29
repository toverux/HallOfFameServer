# Roadmap

Planned work on the server and its web projects that no ticket holds yet.

Every entry opens with a triage line: **Priority** (high, medium, low) and **Cost** as the code reads at triage (trivial, cheap, moderate, large), either one `unsure` when nobody has judged it yet.

## A Hall of Fame wallpaper for Wallpaper Engine

**Priority:** unsure · **Cost:** moderate

A Wallpaper Engine web wallpaper, published on its Steam Workshop, that rotates Hall of Fame screenshots on the desktop: a cross-fade between images, the city name and creator in a corner as the mod's main-menu slideshow shows them, and a click on the caption opening the screenshot's viewer page. A web wallpaper is a static HTML page Wallpaper Engine runs in its own Chromium, so it fits as a new project under `projects/`, testable in any browser; only the Wallpaper Engine run itself needs Windows.

The API already serves it, as the code reads:

- `GET /screenshots/weighted` picks a screenshot by the slideshow's algorithm weights and accepts anonymous requests (`CreatorAuthorizationGuard`). It writes nothing, and without a creator it never skips screenshots already seen.
- `GET /screenshots/:id/fhd.jpg` and `4k.jpg` redirect to the CDN image, `GET /screenshots/:id/viewer` to the viewer page.
- `app.enableCors()` lets the page call the API from Wallpaper Engine's origin.
- `GET /screenshots?creatorId=` takes a creator name, for a wallpaper showing one creator's screenshots.

Wallpaper Engine's user properties, declared in the wallpaper's `project.json` and read through `window.wallpaperPropertyListener.applyUserProperties`, carry the settings: the interval, the algorithm weights, FHD or 4K, a creator filter, and the caption's visibility.

Open points:

- CDN egress: each desktop pulls a full image per interval, all day. Default to FHD and an interval of several minutes.
- Views: `POST /screenshots/:id/views` requires a creator, so wallpaper displays count nowhere. Whether they should, and as what, is undecided: a desktop showing screenshots all day would outweigh players' views.
- Nothing tells wallpaper requests apart from the mod's; a query parameter such as `client=wallpaper` would, if its traffic is worth measuring.
