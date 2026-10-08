# Demo script

Recording: not yet added. This page is the script for a 60 to 90 second screen recording of Trailmates MCP in an MCP client. The maintainer will add the video link here once it is recorded.

Setup: connect the client to the server (`claude mcp add --transport http trailmates <your-url>/mcp`), then run `/mcp` in Claude Code and choose to authenticate. Do not show tokens, and crop or blur the GitHub handle on the consent page.

## 1. Sign in (about 10 s)

Show the per-client consent page (it names the client and the permissions it asks for), approve, then GitHub sign-in. Back in the client the `trailmates` server shows as connected.

## 2. Search with Eaton hidden (about 15 s)

> What waterfalls can I hike near Pasadena and Malibu? Shaded if possible.

Expected: `search_hikes` returns open waterfall trails such as Solstice Canyon and Escondido Falls. The two Eaton Canyon entrances do not appear, because they are closed.

## 3. Include closed trails (about 15 s)

> Same search, but include closed trails.

Expected: with `include_closed` true, Eaton Canyon appears with status `closed` and `closed_through` of 2027-12-31.

## 4. Add a private hike (about 15 s)

> Add a private hike called "Backyard Test Loop" in Altadena: trailhead at the end of my street, a 1.5 mile loop, easy, about 100 ft of gain, tags quiet and shaded, description "Short shaded loop I walk after work."

Expected: `add_hike` returns an id starting with `u:` and a message that it may take a few seconds to appear in search.

## 5. Find it (about 15 s)

> Search my hikes for a short quiet shaded loop after work.

Expected: the new hike appears with source `private`. Indexing is asynchronous, so if it is missing, wait a few seconds and ask again.

## 6. Delete it (about 10 s)

> Delete that hike.

Expected: `delete_hike` replies "Deleted." and a repeat of the search no longer returns it.
