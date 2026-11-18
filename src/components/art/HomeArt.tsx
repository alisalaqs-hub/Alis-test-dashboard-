/**
 * The picture for a home that has no photograph: every example listing, and a real listing until its
 * photos arrive. `hue` belongs to the home, so it looks the same on every page. `scene` asks for one
 * of the rooms instead of the outside view (the gallery of an example listing).
 */
import { Canvas } from './kit';
import { Bungalow, Commercial, Detached, Flats, Semi, Terraced } from './exteriors';
import { Balcony, Bathroom, Bedroom, Garden, Kitchen, LivingRoom, Office, Parking, PlanSheet } from './interiors';

export type Scene = 'front' | 'living' | 'kitchen' | 'bedroom' | 'bathroom' | 'garden' | 'balcony' | 'office' | 'reception' | 'parking' | 'plan';

const SCENES: [RegExp, Scene][] = [
  [/living|lounge|sitting/i, 'living'], [/kitchen|dining/i, 'kitchen'], [/bed/i, 'bedroom'], [/bath|shower/i, 'bathroom'],
  [/garden|patio|yard/i, 'garden'], [/balcony|view|terrace/i, 'balcony'], [/reception/i, 'reception'], [/office/i, 'office'],
  [/park/i, 'parking'], [/plan/i, 'plan'],
];
/** The room a gallery caption names ("Rear garden" → the garden view); the outside view when it names none. */
export const sceneFor = (label: string): Scene => SCENES.find(([re]) => re.test(label))?.[1] ?? 'front';

const LABEL: Record<Scene, string> = {
  front: 'the front of the home', living: 'a living room', kitchen: 'a kitchen', bedroom: 'a bedroom', bathroom: 'a bathroom',
  garden: 'a garden', balcony: 'a balcony', office: 'an office floor', reception: 'a reception', parking: 'a car park', plan: 'a floor plan',
};

/** Spreads the homes' numbers out so neighbours in a list don't share a wall and a door. */
const mix = (hue: number) => (Math.round(hue) * 13 + 5) % 89;

export function HouseArt({ hue, type, after = false, scene = 'front' }: { hue: number; type: string; seed?: number; after?: boolean; scene?: Scene }) {
  const n = mix(hue);
  const art = scene === 'living' ? <LivingRoom n={n} />
    : scene === 'kitchen' ? <Kitchen n={n} />
    : scene === 'bedroom' ? <Bedroom n={n} />
    : scene === 'bathroom' ? <Bathroom n={n} />
    : scene === 'garden' ? <Garden n={n} />
    : scene === 'balcony' ? <Balcony n={n} />
    : scene === 'office' ? <Office n={n} />
    : scene === 'reception' ? <Office n={n} reception />
    : scene === 'parking' ? <Parking n={n} />
    : scene === 'plan' ? <PlanSheet />
    : type === 'flat' ? <Flats n={n} after={after} />
    : type === 'detached' ? <Detached n={n} after={after} />
    : type === 'semi-detached' ? <Semi n={n} after={after} />
    : type === 'bungalow' ? <Bungalow n={n} after={after} />
    : type === 'commercial' ? <Commercial n={n} after={after} />
    : <Terraced n={n} after={after} />;
  return <Canvas label={`Illustration of ${LABEL[scene]} (not a photograph)`}>{art}</Canvas>;
}
