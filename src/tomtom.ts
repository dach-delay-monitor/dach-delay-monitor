import axios from 'axios';
import { TOMTOM_API_KEY } from './config';

export interface TomTomResult {
  travelTimeInSeconds: number;
  found: boolean;
}

/**
 * Calculates truck driving time between two coordinate pairs via TomTom Routing API.
 * originCoords / destCoords format: "lat,lon" (e.g. "52.5200,13.4050")
 */
export async function getTruckTravelTime(
  originCoords: string,
  destCoords: string
): Promise<TomTomResult> {
  const origin = originCoords.replace(/\s+/g, '');
  const dest = destCoords.replace(/\s+/g, '');

  if (!origin || !dest) return { travelTimeInSeconds: 0, found: false };

  const url = `https://api.tomtom.com/routing/1/calculateRoute/${origin}:${dest}/json`;

  try {
    const res = await axios.get(url, {
      params: {
        key: TOMTOM_API_KEY,
        travelMode: 'truck',
        vehicleCommercial: 'true',
      },
      timeout: 15_000,
    });

    const seconds = res.data?.routes?.[0]?.summary?.travelTimeInSeconds ?? 0;
    return { travelTimeInSeconds: seconds, found: seconds > 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[TomTom] API call failed for ${origin}→${dest}: ${message}`);
    return { travelTimeInSeconds: 0, found: false };
  }
}
