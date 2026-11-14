# Maps

Maps adds a place search panel to the Workbench sidebar in DSH Web and Desktop. Enter a city, neighborhood, or address to open the map. Add a place name or choose a category to find places nearby. Select a pin or result to inspect the place, copy its link, or open it in OpenStreetMap. Choose approximate or precise device location to start a nearby search. You can also enter an area manually.

Use the map buttons or plus and minus to zoom. Drag the map or use the arrow keys to pan. To ask DSH about the area, enter a question and select **Open draft chat**. Workbench starts a chat in the current or most recent workspace and drafts the question with the area, selected place, and nearby results. Review the draft before sending it.

## Data and setup

- No API key is required for the defaults. Place search runs on demand through the public [Photon demo](https://github.com/komoot/photon). It receives your typed searches and the coordinates of the resolved area when you search nearby.
- The client loads the visible map tiles from [OpenStreetMap](https://operations.osmfoundation.org/policies/tiles/) and displays attribution. Device location is requested only when you choose a location button. Approximate mode rounds coordinates before sending them to Photon. The plugin does not store searches or prefetch tiles.
- Both public endpoints can rate limit or be unavailable. Use your own compatible services for heavier use. Set `photonURL` to the Photon forward search endpoint (such as `https://photon.example.org/api`) and `tileURL` to an HTTPS OpenStreetMap tile template under the `dsh-maps` entry in your profile's Cordis patch. Nearby categories also use the Photon `reverse` endpoint alongside `api`. Use a tile provider that permits your deployment and the displayed attribution.
- Maps needs a workspace to open a draft chat. Place data depends on the OpenStreetMap coverage in the area.
