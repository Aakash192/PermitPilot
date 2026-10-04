import { useEffect, useRef, useState } from "react"
import mapboxgl, { type GeoJSONSource, type Map as MapboxMap } from "mapbox-gl"
import type { FeatureCollection, Point } from "geojson"
import type { Permit } from "./types"
import "mapbox-gl/dist/mapbox-gl.css"

type Mode = "2d" | "3d"

type Props = {
  permits: Permit[]
  visibleIds: string[] | null
  focus: { id: string; n: number } | null
}

const CENTER: [number, number] = [-114.0708, 51.0486]

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }
    return map[char] ?? char
  })
}

function shortCategory(category: string): string {
  return category.replace(/^Residential\s*-\s*/i, "") || "Permit"
}

function popupHtml(permit: Permit): string {
  const homes = permit.stated ? `${permit.homes} homes` : `About ${permit.homes} homes`
  const applied = permit.applied ? permit.applied.slice(0, 10) : ""
  const meta = [shortCategory(permit.category), permit.status, permit.community, permit.quadrant]
    .filter(Boolean)
    .join(" · ")
  return `
    <div class="popup-id">${escapeHtml(permit.id)}</div>
    <div class="popup-title">${escapeHtml(permit.address || "No address")}</div>
    <div class="popup-meta">${escapeHtml(homes)}</div>
    <div class="popup-meta">${escapeHtml(meta)}</div>
    ${applied ? `<div class="popup-meta">Applied ${escapeHtml(applied)}</div>` : ""}
    <div class="popup-meta">${escapeHtml(permit.basis)}</div>
  `
}

function collection(permits: Permit[], selected: boolean): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: permits.map((permit) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [permit.lng, permit.lat] },
      properties: { id: permit.id, selected },
    })),
  }
}

const ORBIT_ZOOM = 18.5
const ORBIT_PITCH = 67
const ORBIT_PADDING = { top: 48, bottom: 0, left: 0, right: 300 }

function orbitAround(map: MapboxMap, permit: Permit, token: { current: number }, id: number, openPopup: (permit: Permit) => void) {
  if (map.getLayer("permit-buildings")) map.setLayoutProperty("permit-buildings", "visibility", "visible")
  map.dragRotate.enable()
  map.touchZoomRotate.enableRotation()
  const center: [number, number] = [permit.lng, permit.lat]
  openPopup(permit)
  map.easeTo({
    center,
    zoom: ORBIT_ZOOM,
    pitch: ORBIT_PITCH,
    padding: ORBIT_PADDING,
    duration: 1300,
    essential: true,
  })
  const spin = () => {
    if (token.current !== id) return
    if (Math.abs(map.getZoom() - ORBIT_ZOOM) > 0.35) {
      map.once("moveend", spin)
      return
    }
    const started = performance.now()
    const bearing = map.getBearing()
    const frame = (now: number) => {
      if (token.current !== id) return
      map.jumpTo({
        center,
        zoom: ORBIT_ZOOM,
        pitch: ORBIT_PITCH,
        padding: ORBIT_PADDING,
        bearing: bearing + ((now - started) / 1000) * 20,
      })
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }
  map.once("moveend", spin)
}

function applyMode(map: MapboxMap, mode: Mode) {
  const buildings = map.getLayer("permit-buildings")
  if (buildings) map.setLayoutProperty("permit-buildings", "visibility", mode === "3d" ? "visible" : "none")
  if (mode === "3d") {
    map.dragRotate.enable()
    map.touchZoomRotate.enableRotation()
    map.easeTo({ pitch: 62, bearing: -18, duration: 850 })
    return
  }
  map.dragRotate.disable()
  map.touchZoomRotate.disableRotation()
  map.easeTo({ pitch: 0, bearing: 0, duration: 850 })
}

export function MapView({ permits, visibleIds, focus }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapboxMap | null>(null)
  const popupRef = useRef<mapboxgl.Popup | null>(null)
  const permitsRef = useRef(permits)
  const modeRef = useRef<Mode>("2d")
  const orbitToken = useRef(0)
  const orbitingRef = useRef(false)
  const [mode, setMode] = useState<Mode>("2d")
  const [ready, setReady] = useState(false)
  permitsRef.current = permits
  modeRef.current = mode

  function openPopup(permit: Permit) {
    const map = mapRef.current
    if (!map) return
    popupRef.current?.remove()
    popupRef.current = new mapboxgl.Popup({ closeButton: false, maxWidth: "280px", offset: 12 })
      .setLngLat([permit.lng, permit.lat])
      .setHTML(popupHtml(permit))
      .addTo(map)
  }

  function showPermit(permit: Permit) {
    const map = mapRef.current
    if (!map) return
    orbitingRef.current = true
    setMode("3d")
    const id = ++orbitToken.current
    orbitAround(map, permit, orbitToken, id, openPopup)
  }
  const showPermitRef = useRef(showPermit)
  showPermitRef.current = showPermit

  useEffect(() => {
    const container = elRef.current
    if (!container || mapRef.current) return
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
    const map = new mapboxgl.Map({
      container,
      style: "mapbox://styles/mapbox/light-v11",
      center: CENTER,
      zoom: 11,
      pitch: 0,
      bearing: 0,
      maxZoom: 20,
      antialias: true,
      attributionControl: true,
    })
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true, showCompass: true }), "top-right")
    map.dragRotate.disable()
    map.touchZoomRotate.disableRotation()
    mapRef.current = map

    map.on("load", () => {
      const labelId = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id
      map.addLayer(
        {
          id: "permit-buildings",
          source: "composite",
          "source-layer": "building",
          filter: ["==", ["get", "extrude"], "true"],
          type: "fill-extrusion",
          minzoom: 13,
          layout: { visibility: "none" },
          paint: {
            "fill-extrusion-color": "#d6d3d1",
            "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 13.6, ["get", "height"]],
            "fill-extrusion-base": ["get", "min_height"],
            "fill-extrusion-opacity": 0.82,
          },
        },
        labelId,
      )
      map.addSource("permits", { type: "geojson", data: collection([], false) })
      map.addLayer({
        id: "permit-points",
        type: "circle",
        source: "permits",
        paint: {
          "circle-pitch-alignment": "viewport",
          "circle-radius": ["case", ["get", "selected"], 7, 4.5],
          "circle-color": ["case", ["get", "selected"], "#2563eb", "#292524"],
          "circle-stroke-width": ["case", ["get", "selected"], 1.5, 1],
          "circle-stroke-color": ["case", ["get", "selected"], "#1e3a8a", "#ffffff"],
          "circle-opacity": 0.95,
        },
      })
      map.on("click", "permit-points", (event) => {
        const id = event.features?.[0]?.properties?.id
        if (typeof id !== "string") return
        const permit = permitsRef.current.find((item) => item.id === id)
        if (!permit) return
        showPermitRef.current(permit)
      })
      const releaseOrbit = () => {
        orbitToken.current += 1
        orbitingRef.current = false
        map.stop()
      }
      map.on("mousedown", releaseOrbit)
      map.on("dragstart", releaseOrbit)
      map.on("wheel", releaseOrbit)
      map.on("mouseenter", "permit-points", () => {
        map.getCanvas().style.cursor = "pointer"
      })
      map.on("mouseleave", "permit-points", () => {
        map.getCanvas().style.cursor = ""
      })
      applyMode(map, modeRef.current)
      setReady(true)
    })

    return () => {
      orbitToken.current += 1
      popupRef.current?.remove()
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (orbitingRef.current && mode === "3d") return
    orbitToken.current += 1
    orbitingRef.current = false
    applyMode(map, mode)
  }, [mode, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const source = map.getSource("permits")
    if (!source || source.type !== "geojson") return
    const allowed = visibleIds ? new Set(visibleIds) : null
    const visible = allowed ? permits.filter((permit) => allowed.has(permit.id)) : permits
    ;(source as GeoJSONSource).setData(collection(visible, allowed != null))
    orbitToken.current += 1
    orbitingRef.current = false
    popupRef.current?.remove()
    if (visible.length === 0) return
    const bounds = new mapboxgl.LngLatBounds()
    for (const permit of visible) bounds.extend([permit.lng, permit.lat])
    const tilted = modeRef.current === "3d"
    map.fitBounds(bounds, {
      padding: { top: 96, left: 28, right: 460, bottom: allowed ? 220 : 80 },
      maxZoom: tilted ? 15.4 : 14,
      duration: 650,
      linear: true,
      pitch: tilted ? 62 : 0,
      bearing: tilted ? map.getBearing() : 0,
    })
  }, [permits, visibleIds, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!focus || !map || !ready) return
    const permit = permitsRef.current.find((item) => item.id === focus.id)
    if (!permit) return
    showPermit(permit)
  }, [focus, ready])

  return (
    <div className="map-shell">
      <div ref={elRef} className="map-root" />
      <div className="map-mode" role="group" aria-label="Map mode">
        <button
          type="button"
          className={mode === "2d" ? "on" : ""}
          aria-pressed={mode === "2d"}
          onClick={() => {
            orbitingRef.current = false
            orbitToken.current += 1
            setMode("2d")
          }}
        >
          2D
        </button>
        <button
          type="button"
          className={mode === "3d" ? "on" : ""}
          aria-pressed={mode === "3d"}
          onClick={() => {
            orbitingRef.current = false
            orbitToken.current += 1
            setMode("3d")
          }}
        >
          3D
        </button>
      </div>
    </div>
  )
}
