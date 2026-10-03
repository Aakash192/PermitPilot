import { useEffect, useRef } from "react"
import L from "leaflet"
import type { Permit } from "./types"

type Props = {
  permits: Permit[]
  visibleIds: string[] | null
  focus: { id: string; n: number } | null
}

const INK = {
  radius: 4.5,
  color: "#ffffff",
  weight: 1,
  fillColor: "#292524",
  fillOpacity: 0.88,
}
const BLUE = {
  radius: 7,
  color: "#1e3a8a",
  weight: 1.5,
  fillColor: "#2563eb",
  fillOpacity: 0.95,
}

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

export function MapView({ permits, visibleIds, focus }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map())

  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    const map = L.map(elRef.current, {
      zoomControl: false,
      preferCanvas: true,
      fadeAnimation: false,
      maxZoom: 18,
    }).setView([51.0486, -114.0708], 11)
    map.attributionControl.setPosition("bottomleft")
    L.control.zoom({ position: "topright" }).addTo(map)
    const token = import.meta.env.VITE_MAPBOX_TOKEN
    L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}?access_token=${token}`,
      {
        attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        tileSize: 512,
        zoomOffset: -1,
        maxZoom: 18,
      },
    ).addTo(map)
    mapRef.current = map
    requestAnimationFrame(() => map.invalidateSize())
    return () => {
      map.remove()
      mapRef.current = null
      markersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((marker) => marker.remove())
    markersRef.current.clear()

    const allowed = visibleIds ? new Set(visibleIds) : null
    const visible = allowed ? permits.filter((permit) => allowed.has(permit.id)) : permits
    const selected = allowed != null

    for (const permit of visible) {
      const marker = L.circleMarker([permit.lat, permit.lng], selected ? BLUE : INK)
      marker.bindPopup(popupHtml(permit), { closeButton: false, maxWidth: 280 })
      marker.addTo(map)
      markersRef.current.set(permit.id, marker)
    }

    if (visible.length === 0) return
    const bounds = L.latLngBounds(visible.map((permit) => [permit.lat, permit.lng]))
    const filtered = selected
    map.fitBounds(bounds, {
      paddingTopLeft: [24, 84],
      paddingBottomRight: filtered ? [440, 420] : [440, 150],
      maxZoom: 14,
      animate: false,
    })
  }, [permits, visibleIds])

  useEffect(() => {
    if (!focus) return
    const marker = markersRef.current.get(focus.id)
    const map = mapRef.current
    if (!marker || !map) return
    const zoom = Math.max(map.getZoom(), 15)
    map.flyTo(marker.getLatLng(), zoom, { duration: 0.55 })
    marker.openPopup()
  }, [focus])

  return <div ref={elRef} className="map-root" />
}
