/*******************
* CANVAS AND STATE *
*******************/

const displayCanvas = document.querySelector("#planet");
const displayContext = displayCanvas.getContext("2d");
const renderCanvas = document.createElement("canvas");
const renderContext = renderCanvas.getContext("2d");

const starfield = document.querySelector("#starfield");
const starContext = starfield.getContext("2d");

const generateButton = document.querySelector("#generate-button");

// A 192-pixel scene contains the largest orbit and rings, with margin.
// Keep the original 448 / 128 display scale on desktop.
const RENDER_WIDTH = 192;
const RENDER_HEIGHT = 192;
const RENDER_CENTER_X = RENDER_WIDTH / 2;
const RENDER_CENTER_Y = RENDER_HEIGHT / 2;
const depthBuffer = new Float32Array(RENDER_WIDTH * RENDER_HEIGHT);
const sceneImage = renderContext.createImageData(RENDER_WIDTH, RENDER_HEIGHT);

renderCanvas.width = RENDER_WIDTH;
renderCanvas.height = RENDER_HEIGHT;

let displayScale = 3.5;
let displayWidth = 0;
let displayHeight = 0;
let starTime = 0;

const stars = Array.from({ length: 650 }, function () {
  let size = 1;

  if (Math.random() > 0.92) {
    size = 2;
  }

  return {
    x: Math.random(),
    y: Math.random(),
    size,
    alpha: randomFloat(0.08, 0.55),
    phase: randomFloat(0, Math.PI * 2),
    speed: randomFloat(0.35, 1.1),
    warmth: Math.random()
  };
});

let celestialObject = null;

let rotationAngle = 0;
let cloudAngle = 0;
let animationTime = 0;

let lightX = -0.58;
let lightY = -0.42;
let lightZ = 0.70;

let lastFrameTime = performance.now();

let objectStyles = null;
let objectTypes = [];
let sceneCenterY = 0;

const loadError = document.querySelector("#load-error");


/*****************
* MATH AND NOISE *
*****************/

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(randomFloat(min, max + 1));
}

function pick(array) {
  return array[randomInt(0, array.length - 1)];
}

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

function mixColor(baseColor, targetColor, amount) {
  return [
    Math.round(baseColor[0] + (targetColor[0] - baseColor[0]) * amount),
    Math.round(baseColor[1] + (targetColor[1] - baseColor[1]) * amount),
    Math.round(baseColor[2] + (targetColor[2] - baseColor[2]) * amount)
  ];
}

function darken(color, factor) {
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor)
  ];
}

function hash3(x, y, z, localSeed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + localSeed * 91.7) * 43758.5453123;

  return value - Math.floor(value);
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function valueNoise3(x, y, z, localSeed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);

  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const tz = fade(z - z0);

  const c000 = hash3(x0, y0, z0, localSeed);
  const c100 = hash3(x1, y0, z0, localSeed);
  const c010 = hash3(x0, y1, z0, localSeed);
  const c110 = hash3(x1, y1, z0, localSeed);

  const c001 = hash3(x0, y0, z1, localSeed);
  const c101 = hash3(x1, y0, z1, localSeed);
  const c011 = hash3(x0, y1, z1, localSeed);
  const c111 = hash3(x1, y1, z1, localSeed);

  const x00 = lerp(c000, c100, tx);
  const x10 = lerp(c010, c110, tx);
  const x01 = lerp(c001, c101, tx);
  const x11 = lerp(c011, c111, tx);

  const y0Value = lerp(x00, x10, ty);
  const y1Value = lerp(x01, x11, ty);

  return lerp(y0Value, y1Value, tz);
}

function fbm3(x, y, z, localSeed, octaves, scale) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maximum = 0;

  for (let i = 0; i < octaves; i++) {
    value += valueNoise3(x * frequency / scale, y * frequency / scale, z * frequency / scale, localSeed + i * 37.17) * amplitude;

    maximum += amplitude;

    amplitude *= 0.5;
    frequency *= 2;
  }

  return value / maximum;
}

function ridgedNoise3(x, y, z, localSeed, scale) {
  const value = fbm3(x, y, z, localSeed, 4, scale);

  return 1 - Math.abs(value * 2 - 1);
}

function spherePoint(x, y, radius) {
  const nx = (x - RENDER_CENTER_X) / radius;
  const ny = (y - RENDER_CENTER_Y) / radius;

  const distanceSquared = nx * nx + ny * ny;

  if (distanceSquared > 1) {
    return null;
  }

  const nz = Math.sqrt(1 - distanceSquared);

  return {
    x: nx,
    y: ny,
    z: nz
  };
}

function rotateY(surfaceNormal, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);

  return {
    x: surfaceNormal.x * cosine - surfaceNormal.z * sine,
    y: surfaceNormal.y,
    z: surfaceNormal.x * sine + surfaceNormal.z * cosine
  };
}


/********************
* PIXEL COMPOSITING *
********************/

function setPixel(imageData, x, y, color, alpha) {
  if (x < 0 || x >= RENDER_WIDTH || y < 0 || y >= RENDER_HEIGHT) {
    return;
  }

  const index = (y * RENDER_WIDTH + x) * 4;

  imageData.data[index] = color[0];
  imageData.data[index + 1] = color[1];
  imageData.data[index + 2] = color[2];
  imageData.data[index + 3] = alpha;
}

function blendPixel(imageData, x, y, color, alpha) {
  if (x < 0 || x >= RENDER_WIDTH || y < 0 || y >= RENDER_HEIGHT) {
    return;
  }

  const index = (y * RENDER_WIDTH + x) * 4;

  const sourceAlpha = alpha / 255;
  const destinationAlpha = imageData.data[index + 3] / 255;

  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);

  if (outputAlpha <= 0) {
    return;
  }

  imageData.data[index] = Math.round((color[0] * sourceAlpha + imageData.data[index] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);

  imageData.data[index + 1] = Math.round((color[1] * sourceAlpha + imageData.data[index + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);

  imageData.data[index + 2] = Math.round((color[2] * sourceAlpha + imageData.data[index + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);

  imageData.data[index + 3] = Math.round(outputAlpha * 255);
}


/********************
* DIRECTIONAL LIGHT *
********************/

function getLight(surfaceNormal) {
  const dot = surfaceNormal.x * lightX + surfaceNormal.y * lightY + surfaceNormal.z * lightZ;

  return clamp(0.18 + Math.max(0, dot) * 0.94, 0.16, 1.05);
}

function getLightIntensity(value) {
  const lightLevels = objectStyles.lighting.bands;
  const normalizedLight = clamp((value - 0.18) / 0.82, 0, 1);
  const levelIndex = Math.min(Math.floor(normalizedLight * lightLevels.length), lightLevels.length - 1);

  // Keep distinct lighting bands to preserve the pixel art shading.
  return lightLevels[levelIndex];
}

function shadeSurface(color, surfaceNormal) {
  const lighting = getLightIntensity(getLight(surfaceNormal));

  return darken(color, lighting);
}


/***********************
* PLANET CONFIGURATION *
***********************/

function createObject(requestedType) {
  let type = requestedType;

  if (!type) {
    type = selectObjectType();
  }

  const radius = randomInt(...type.radius);

  const worldSeed = randomFloat(100, 10000);

  const hasRings = Math.random() < type.ringChance;

  const moonCount = randomInt(type.moonMin, Math.min(3, type.moonMax));

  const ring = createRing(hasRings);

  const moons = createMoons(moonCount, radius, worldSeed);

  const palette = pick(type.palettes);

  const configuration = {
    type,
    radius,
    seed: worldSeed,
    palette,
    hasRings,
    ring,
    moons,
    rotationSpeed: randomFloat(...type.rotationSpeed),
    cloudSpeed: randomFloat(...type.clouds.speed),
    waterLevel: randomFloat(...type.waterLevel),
    cloudThreshold: randomFloat(...type.clouds.threshold),
    atmosphereStrength: randomFloat(...type.halo.strength),
    anomalyPhase: randomFloat(0, Math.PI * 2),
    craters: createCraters(type.id),
    stormLatitude: randomFloat(-0.45, 0.45),
    stormLongitude: randomFloat(-Math.PI, Math.PI)
  };

  return configuration;
}

function createRing(enabled) {
  if (!enabled) {
    return null;
  }

  const style = objectStyles.rings;
  const ring = {
    inner: randomFloat(...style.inner),
    outer: randomFloat(...style.outer),
    tilt: randomFloat(...style.tilt),
    rotation: randomFloat(...style.rotation),
    color: pick(style.colors),
    seed: randomFloat(0, 999),
    opacity: randomFloat(...style.opacity),
    division: randomFloat(0.58, 0.68),
    divisionWidth: randomFloat(0.035, 0.055)
  };
  ring.densityProfile = createRingProfile(ring);

  return ring;
}

// Build irregular radial bands once; they remain concentric during animation.
function createRingProfile(ring) {
  const profile = new Float32Array(512);

  for (let sampleIndex = 0; sampleIndex < profile.length; sampleIndex++) {
    const radialPosition = sampleIndex / (profile.length - 1);
    const broadVariation = valueNoise3(radialPosition * 9, 0, 0, ring.seed);
    const fineVariation = valueNoise3(radialPosition * 65, 0, 0, ring.seed + 50);

    let density = 0.2 + broadVariation * 0.14;

    if (radialPosition > 0.2) {
      density = 0.65 + broadVariation * 0.22;
    }

    if (radialPosition > ring.division) {
      density = 0.4 + broadVariation * 0.22;
    }

    const divisionDistance = Math.abs(radialPosition - ring.division);
    const divisionBlend = smoothTransition(ring.divisionWidth * 0.4, ring.divisionWidth, divisionDistance);

    density *= 0.06 + divisionBlend * 0.94;
    density *= 0.86 + fineVariation * 0.14;
    density *= smoothTransition(0, 0.055, radialPosition);
    density *= 1 - smoothTransition(0.94, 1, radialPosition);

    profile[sampleIndex] = density;
  }

  return profile;
}

function smoothTransition(start, end, value) {
  const fraction = clamp((value - start) / (end - start), 0, 1);

  return fraction * fraction * (3 - 2 * fraction);
}

function createMoons(count, radius, localSeed) {
  const moons = [];

  for (let i = 0; i < count; i++) {
    moons.push({
      radius: randomInt(2, 5),
      orbit: radius * randomFloat(1.55, 2.15),
      angle: randomFloat(0, Math.PI * 2),
      speed: randomFloat(0.05, 0.14),
      inclination: randomFloat(0.3, 0.75),
      seed: localSeed + i * 234.7,
      color: pick(objectStyles.moons.colors)
    });
  }

  return moons;
}


/******************
* PLANET SURFACES *
******************/

function surfaceColor(objectData, rotated, surfaceNormal) {
  if (objectData.type.id === "desert") {
    return desertColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "gas") {
    return gasColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "rocky") {
    return rockyColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "habitable") {
    return habitableColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "ocean") {
    return oceanColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "frozen") {
    return frozenColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "volcanic") {
    return volcanicColor(objectData, rotated, surfaceNormal);
  }

  if (objectData.type.id === "hostile") {
    return hostileColor(objectData, rotated, surfaceNormal);
  }

  return anomalousColor(objectData, rotated, surfaceNormal);
}

function desertColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;
  const terrain = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 4, 0.75);
  const distortion = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 84, 3, 0.38);
  const duneWave = Math.sin(surfacePoint.x * 32 + surfacePoint.z * 21 + distortion * 19);
  const duneCoverage = clamp((terrain - 0.37) * 3, 0, 0.65);

  let color = mixColor(palette[1], palette[3], clamp(terrain * 1.3, 0, 1));

  if (duneWave > 0.55) {
    color = mixColor(color, palette[4], duneCoverage);
  } else if (duneWave < -0.6) {
    color = mixColor(color, palette[0], duneCoverage * 0.45);
  }

  return shadeSurface(color, surfaceNormal);
}

function gasColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;
  const turbulence = fbm3(surfacePoint.x, surfacePoint.y * 1.6, surfacePoint.z, objectData.seed, 4, 0.42);
  const bands = surfacePoint.y * 17 + (turbulence - 0.5) * 4;
  const bandValue = clamp(0.5 + Math.sin(bands) * 0.3 + (turbulence - 0.5) * 0.4, 0, 1);
  const paletteIndex = Math.min(palette.length - 2, Math.floor(bandValue * (palette.length - 1)));

  let color = mixColor(palette[paletteIndex], palette[paletteIndex + 1], (bandValue * (palette.length - 1)) % 1);

  const longitude = Math.atan2(surfacePoint.z, surfacePoint.x);
  const longitudeDelta = Math.atan2(Math.sin(longitude - objectData.stormLongitude), Math.cos(longitude - objectData.stormLongitude));
  const stormDistance = Math.hypot(longitudeDelta / 0.32, (surfacePoint.y - objectData.stormLatitude) / 0.12);

  if (stormDistance < 1) {
    const swirl = 0.5 + 0.5 * Math.sin(stormDistance * 15 + turbulence * 5);
    color = mixColor(palette[1], palette[3], 0.25 + swirl * 0.45);
  }

  return shadeSurface(color, surfaceNormal);
}

function rockyColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;

  const terrain = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 5, 0.42);

  const details = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 120, 3, 0.15);

  let color = palette[2];

  if (terrain < 0.32) {
    color = palette[0];
  } else if (terrain < 0.48) {
    color = palette[1];
  } else if (terrain < 0.68) {
    color = palette[2];
  } else if (terrain < 0.83) {
    color = palette[3];
  } else {
    color = palette[4];
  }

  if (details > 0.8) {
    color = mixColor(color, palette[0], 0.25);
  }

  for (const crater of objectData.craters) {
    const craterDistance = Math.hypot(surfacePoint.x - crater.x, surfacePoint.y - crater.y, surfacePoint.z - crater.z) / crater.radius;

    if (craterDistance < 0.78) {
      color = mixColor(color, palette[0], 0.36);
    } else if (craterDistance < 1) {
      color = mixColor(color, palette[4], 0.45);
    }
  }

  return shadeSurface(color, surfaceNormal);
}

function habitableColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;

  const terrain = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 5, 0.78);

  const mountains = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 310, 4, 0.16);

  let color;

  if (terrain < objectData.waterLevel - 0.13) {
    color = palette.deepOcean;
  } else if (terrain < objectData.waterLevel - 0.04) {
    color = palette.ocean;
  } else if (terrain < objectData.waterLevel) {
    color = palette.shallow;
  } else if (terrain < objectData.waterLevel + 0.016) {
    color = palette.beach;
  } else if (terrain < objectData.waterLevel + 0.16) {
    color = palette.vegetation;
  } else {
    color = palette.vegetationLight;
  }

  if (terrain > objectData.waterLevel + 0.08 && mountains > 0.72) {
    color = palette.mountain;
  }

  if (terrain > objectData.waterLevel + 0.14 && mountains > 0.84) {
    color = palette.snow;
  }

  if (Math.abs(surfacePoint.y) > 0.91 + (mountains - 0.5) * 0.09) {
    color = palette.snow;
  }

  return shadeSurface(color, surfaceNormal);
}

function oceanColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;

  const terrain = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 5, 0.5);

  let color;

  if (terrain < objectData.waterLevel - 0.16) {
    color = palette.abyss;
  } else if (terrain < objectData.waterLevel - 0.07) {
    color = palette.deep;
  } else if (terrain < objectData.waterLevel) {
    color = palette.ocean;
  } else if (terrain < objectData.waterLevel + 0.03) {
    color = palette.shallow;
  } else if (terrain < objectData.waterLevel + 0.055) {
    color = palette.beach;
  } else {
    color = palette.island;
  }

  return shadeSurface(color, surfaceNormal);
}

function frozenColor(objectData, surfacePoint, surfaceNormal) {
  const snow = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 5, 0.55);
  const fractures = ridgedNoise3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 930, 0.19);

  let color = mixColor(objectData.palette.ice, objectData.palette.snow, clamp((snow - 0.25) * 2, 0, 1));

  if (fractures > 0.975) {
    color = mixColor(color, objectData.palette.fracture, 0.5);
  }

  return shadeSurface(color, surfaceNormal);
}

function volcanicColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;

  const terrain = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 5, 0.45);

  const lavaField = ridgedNoise3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 500, 0.18);

  let color;

  if (terrain < 0.38) {
    color = palette.black;
  } else if (terrain < 0.6) {
    color = palette.darkRock;
  } else if (terrain < 0.78) {
    color = palette.rock;
  } else {
    color = palette.hotRock;
  }

  if (lavaField > 0.91) {
    color = palette.lava;
  }

  if (lavaField > 0.96) {
    color = palette.hotLava;
  }

  if (lavaField > 0.985) {
    color = palette.core;
  }

  const shaded = shadeSurface(color, surfaceNormal);
  if (lavaField > 0.91) {
    return mixColor(shaded, color, 0.65);
  }

  return shaded;
}

function hostileColor(objectData, surfacePoint, surfaceNormal) {
  const palette = objectData.palette;

  const terrain = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 5, 0.48);

  const toxicPatch = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 700, 4, 0.22);

  let index = Math.floor(terrain * palette.length);

  index = clamp(index, 0, palette.length - 1);

  let color = palette[index];

  if (toxicPatch > 0.76) {
    color = mixColor(color, palette[palette.length - 1], 0.45);
  }

  return shadeSurface(color, surfaceNormal);
}

function anomalousColor(objectData, surfacePoint, surfaceNormal) {
  const field = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed, 4, 0.43);
  const veins = ridgedNoise3(surfacePoint.x, surfacePoint.y, surfacePoint.z, objectData.seed + 900, 0.26);
  const palette = objectData.palette;
  const index = clamp(Math.floor(field * palette.length), 0, palette.length - 1);
  const color = shadeSurface(palette[index], surfaceNormal);

  if (veins > 0.96) {
    const pulse = 0.65 + 0.12 * Math.sin(animationTime * 0.65 + objectData.anomalyPhase);
    return mixColor(color, objectData.type.surfaceColors.veins, pulse);
  }

  return color;
}


/***************************
* SURFACE AND CLOUD LAYERS *
***************************/

function drawPlanetSurface(imageData) {
  for (let y = 0; y < RENDER_HEIGHT; y++) {
    for (let x = 0; x < RENDER_WIDTH; x++) {
      const surfaceNormal = spherePoint(x + 0.5, y + 0.5, celestialObject.radius);

      if (!surfaceNormal) {
        continue;
      }

      depthBuffer[y * RENDER_WIDTH + x] = surfaceNormal.z * celestialObject.radius;

      const rotated = rotateY(surfaceNormal, rotationAngle);

      const color = surfaceColor(celestialObject, rotated, surfaceNormal);

      setPixel(imageData, x, y, color, 255);
    }
  }
}

function drawClouds(imageData) {
  const style = celestialObject.type.clouds;

  if (!style.enabled) {
    return;
  }

  const threshold = celestialObject.cloudThreshold;
  const tint = style.color;

  // Independent rotation and warped noise create drifting cloud banks.
  for (let y = 0; y < RENDER_HEIGHT; y++) {
    for (let x = 0; x < RENDER_WIDTH; x++) {
      const surfaceNormal = spherePoint(x + 0.5, y + 0.5, celestialObject.radius);
      if (!surfaceNormal) {
        continue;
      }

      const surfacePoint = rotateY(surfaceNormal, cloudAngle);
      const warp = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z, celestialObject.seed + 7200, 3, 0.6);
      const noise = fbm3(surfacePoint.x + warp * 0.35, surfacePoint.y * 1.35, surfacePoint.z - warp * 0.25, celestialObject.seed + 4000, 5, 0.42);

      if (noise <= threshold) {
        continue;
      }

      const density = clamp((noise - threshold) / 0.19, 0, 1);
      const color = darken(tint, 0.26 + getLightIntensity(getLight(surfaceNormal)) * 0.74);

      blendPixel(imageData, x, y, color, Math.round(density * style.opacity));
    }
  }
}

function drawAtmosphere(imageData) {
  const radius = celestialObject.radius;
  const thickness = 4;

  const color = celestialObject.type.halo.color;

  if (!color) {
    return;
  }

  // Match the pixel centers used by the sphere: no uncovered rim pixels.
  for (let y = RENDER_CENTER_Y - radius - thickness; y <= RENDER_CENTER_Y + radius + thickness; y++) {
    for (let x = RENDER_CENTER_X - radius - thickness; x <= RENDER_CENTER_X + radius + thickness; x++) {
      const offsetX = x + 0.5 - RENDER_CENTER_X;
      const offsetY = y + 0.5 - RENDER_CENTER_Y;

      const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

      if (distance <= radius || distance > radius + thickness) {
        continue;
      }

      const opacity = 1 - (distance - radius) / thickness;

      blendPixel(
        imageData,
        x,
        y,
        color,
        Math.round(opacity * opacity * 150 * (0.3 + 0.7 * Math.max(0, offsetX / distance * lightX + offsetY / distance * lightY)) * celestialObject.atmosphereStrength)
      );
    }
  }
}


/***********************
* RINGS AND SATELLITES *
***********************/

function drawRing(imageData) {
  const ring = celestialObject.ring;

  if (!ring) {
    return;
  }

  const rotationCosine = Math.cos(ring.rotation);
  const rotationSine = Math.sin(ring.rotation);
  const innerRadius = celestialObject.radius * ring.inner;
  const outerRadius = celestialObject.radius * ring.outer;
  const inclinationDepth = Math.sqrt(1 - ring.tilt * ring.tilt);
  const normalLight = -rotationSine * inclinationDepth * lightX - rotationCosine * inclinationDepth * lightY + ring.tilt * lightZ;
  const planeBrightness = 0.48 + Math.abs(normalLight) * 0.52;
  const pixelOffsets = [0.25, 0.75];

  for (let pixelY = Math.floor(RENDER_CENTER_Y - outerRadius); pixelY <= RENDER_CENTER_Y + outerRadius; pixelY++) {
    for (let pixelX = Math.floor(RENDER_CENTER_X - outerRadius); pixelX <= RENDER_CENTER_X + outerRadius; pixelX++) {
      let totalOpacity = 0;
      let totalBrightness = 0;

      // Four coverage samples prevent broken edges on the thin projected disk.
      for (const sampleY of pixelOffsets) {
        for (const sampleX of pixelOffsets) {
          const offsetX = pixelX + sampleX - RENDER_CENTER_X;
          const offsetY = pixelY + sampleY - RENDER_CENTER_Y;
          const ringX = offsetX * rotationCosine - offsetY * rotationSine;
          const ringY = offsetX * rotationSine + offsetY * rotationCosine;
          const planeY = ringY / ring.tilt;
          const radialDistance = Math.hypot(ringX, planeY);

          if (radialDistance <= innerRadius || radialDistance >= outerRadius) {
            continue;
          }

          const ringDepth = planeY * inclinationDepth;

          if (ringDepth < depthBuffer[pixelY * RENDER_WIDTH + pixelX]) {
            continue;
          }

          const radialPosition = (radialDistance - innerRadius) / (outerRadius - innerRadius);
          const profilePosition = radialPosition * (ring.densityProfile.length - 1);
          const profileIndex = Math.floor(profilePosition);
          const density = lerp(ring.densityProfile[profileIndex], ring.densityProfile[profileIndex + 1], profilePosition - profileIndex);
          const opacity = (1 - Math.exp(-density * ring.opacity / Math.max(0.22, ring.tilt))) * 0.94;

          let brightness = planeBrightness * (0.85 + density * 0.15);

          // A short soft transition models the sphere's shadow on the ring plane.
          const lightDistance = -(offsetX * lightX + offsetY * lightY + ringDepth * lightZ);

          if (lightDistance > 0) {
            const shadowDistance = Math.hypot(offsetX + lightX * lightDistance, offsetY + lightY * lightDistance, ringDepth + lightZ * lightDistance);
            const shadowVisibility = smoothTransition(celestialObject.radius - 0.8, celestialObject.radius + 0.8, shadowDistance);
            brightness *= 0.22 + shadowVisibility * 0.78;
          }

          totalOpacity += opacity;
          totalBrightness += brightness * opacity;
        }
      }
      if (totalOpacity > 0) {
        const color = darken(ring.color, totalBrightness / totalOpacity);
        blendPixel(imageData, pixelX, pixelY, color, Math.round(totalOpacity / 4 * 255));
      }
    }
  }
}

function getMoonPosition(moon) {
  const angle = moon.angle + animationTime * moon.speed;

  return {
    x: RENDER_CENTER_X + Math.cos(angle) * moon.orbit,
    y: RENDER_CENTER_Y + Math.sin(angle) * moon.orbit * moon.inclination,
    z: Math.sin(angle) * moon.orbit * Math.sqrt(1 - moon.inclination * moon.inclination)
  };
}

function drawMoon(imageData, moon, index) {
  const position = getMoonPosition(moon);

  for (let pixelY = Math.floor(position.y - moon.radius); pixelY <= Math.ceil(position.y + moon.radius); pixelY++) {
    for (let pixelX = Math.floor(position.x - moon.radius); pixelX <= Math.ceil(position.x + moon.radius); pixelX++) {
      if (pixelX < 0 || pixelY < 0 || pixelX >= RENDER_WIDTH || pixelY >= RENDER_HEIGHT) {
        continue;
      }

      const offsetX = (pixelX + 0.5 - position.x) / moon.radius;
      const offsetY = (pixelY + 0.5 - position.y) / moon.radius;
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;

      if (distanceSquared > 1) {
        continue;
      }

      const z = Math.sqrt(1 - distanceSquared);
      const depth = position.z + z * moon.radius;
      const pixelIndex = pixelY * RENDER_WIDTH + pixelX;

      if (depth < depthBuffer[pixelIndex]) {
        continue;
      }

      const detail = fbm3(offsetX, offsetY, z, moon.seed + index * 33, 3, 0.35);

      let color = mixColor(darken(moon.color, 0.55), moon.color, detail);
      color = shadeSurface(color, { x: offsetX, y: offsetY, z });

      depthBuffer[pixelIndex] = depth;
      setPixel(imageData, pixelX, pixelY, color, 255);
    }
  }
}


/******************
* SCENE RENDERING *
******************/

function renderScene() {
  if (!celestialObject) {
    return;
  }

  const imageData = sceneImage;
  imageData.data.fill(0);
  depthBuffer.fill(-Infinity);

  if (celestialObject.type.id === "star") {
    drawStar(imageData);
  } else if (celestialObject.type.id === "blackHole") {
    drawBlackHole(imageData);
  } else {
    drawPlanetSurface(imageData);
    drawClouds(imageData);
    drawAtmosphere(imageData);

    for (let moonIndex = 0; moonIndex < celestialObject.moons.length; moonIndex++) {
      drawMoon(imageData, celestialObject.moons[moonIndex], moonIndex);
    }
    drawRing(imageData);
  }

  renderContext.putImageData(imageData, 0, 0);
  displayContext.clearRect(0, 0, displayWidth, displayHeight);
  displayContext.imageSmoothingEnabled = false;

  const size = RENDER_WIDTH * displayScale;

  displayContext.drawImage(renderCanvas, (displayWidth - size) / 2, sceneCenterY - size / 2, size, size);
}

function generateObject() {
  celestialObject = createObject();
  displayCanvas.setAttribute("aria-label", celestialObject.type.name + " in pixel art");

  rotationAngle =
    randomFloat(0, Math.PI * 2);

  cloudAngle =
    randomFloat(0, Math.PI * 2);

  animationTime = 0;

  renderScene();
}


/*****************
* ANIMATION LOOP *
*****************/

function animate(now) {
  requestAnimationFrame(animate);

  if (document.hidden || now - lastFrameTime < 1000 / 30) {
    return;
  }

  const elapsedSeconds = Math.min(0.1, (now - lastFrameTime) / 1000);

  lastFrameTime = now;
  starTime += elapsedSeconds;

  drawStarfield();

  if (celestialObject) {
    rotationAngle += celestialObject.rotationSpeed * elapsedSeconds;
    cloudAngle += celestialObject.cloudSpeed * elapsedSeconds;
    animationTime += elapsedSeconds;
    renderScene();
  }
}

function updateLightFromPointer(event) {
  // Preserve the original sensitivity: +/-224 CSS pixels at desktop scale.
  let x = (event.clientX - displayWidth / 2) / (64 * displayScale);
  let y = (event.clientY - sceneCenterY) / (64 * displayScale);

  const length = Math.hypot(x, y);

  if (length > 0.92) {
    x = x / length * 0.92;
    y = y / length * 0.92;
  }

  lightX = x;
  lightY = y;
  lightZ = Math.sqrt(Math.max(0, 1 - x * x - y * y));
}


/************
* STARFIELD *
************/

function drawStarfield() {
  starContext.clearRect(0, 0, displayWidth, displayHeight);

  const count = Math.min(stars.length, Math.floor(displayWidth * displayHeight / 4000));

  for (let i = 0; i < count; i++) {
    const star = stars[i];
    let color = "208, 224, 255";

    if (star.warmth > 0.8) {
      color = "255, 229, 198";
    }

    const twinkle = 0.78 + 0.16 * Math.sin(starTime * star.speed + star.phase) + 0.06 * Math.sin(starTime * star.speed * 1.7 + star.phase);

    starContext.fillStyle = "rgba(" + color + "," + star.alpha * twinkle + ")";

    const starX = Math.floor(star.x * displayWidth);
    const starY = Math.floor(star.y * displayHeight);

    starContext.fillRect(starX, starY, star.size, star.size);

    if (star.size === 2 && star.alpha > 0.42) {
      starContext.fillStyle = "rgba(" + color + "," + star.alpha * twinkle * 0.1 + ")";
      starContext.fillRect(starX - 2, starY, 6, 2);
      starContext.fillRect(starX, starY - 2, 2, 6);
    }
  }
}

function resizeScene() {
  displayWidth = window.innerWidth;
  displayHeight = window.innerHeight;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  for (const layer of [displayCanvas, starfield]) {
    layer.width = Math.round(displayWidth * ratio);
    layer.height = Math.round(displayHeight * ratio);
  }

  displayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  starContext.setTransform(ratio, 0, 0, ratio, 0, 0);

  sceneCenterY = displayHeight / 2;
  displayScale = Math.max(0.25, Math.min(3.5, (displayWidth - 24) / 176, (displayHeight - 136) / 176));

  drawStarfield();
  renderScene();
}


/***************
* JSON LOADING *
***************/

function validateStyles(data) {
  const supported = ["habitable", "desert", "volcanic", "frozen", "gas", "ocean", "rocky", "hostile", "anomalous", "star", "blackHole"];

  if (data.version !== 1 || !Array.isArray(data.types) || data.types.length === 0) {
    throw new Error("Invalid planet style configuration.");
  }

  if (!data.lighting || !Array.isArray(data.lighting.bands) || data.lighting.bands.length !== 8 || !data.rings || !data.moons) {
    throw new Error("Missing shared rendering styles.");
  }

  const ids = new Set();

  let totalWeight = 0;

  for (const type of data.types) {
    if (!supported.includes(type.id) || ids.has(type.id) || !type.palettes || !type.palettes.length || !type.clouds || !type.halo) {
      throw new Error("Invalid or duplicate planet type: " + type.id);
    }

    ids.add(type.id);

    if (!Number.isFinite(type.weight) || type.weight < 0) {
      throw new Error("Invalid generation weight for " + type.id);
    }

    totalWeight += type.weight;

    if (!Number.isInteger(type.moonMin) || !Number.isInteger(type.moonMax) || type.moonMin < 0 || type.moonMin > Math.min(3, type.moonMax)) {
      throw new Error("Invalid moon count for " + type.id);
    }

    if (type.id === "blackHole" && type.radius[1] > 30) {
      throw new Error("Black hole radius exceeds the drawing area.");
    }

    for (const range of [type.radius, type.rotationSpeed, type.waterLevel, type.clouds.threshold, type.clouds.speed, type.halo.strength]) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]) {
        throw new Error("Invalid range for " + type.id);
      }
    }

    if (type.radius[0] < 1 || type.radius[1] > 40 || type.ringChance < 0 || type.ringChance > 1) {
      throw new Error("Planet size or ring probability outside supported bounds.");
    }
  }

  if (totalWeight <= 0) {
    throw new Error("At least one object needs a positive generation weight.");
  }
}

async function initialize() {
  generateButton.disabled = true;
  loadError.hidden = true;

  try {
    const response = await fetch("./planets.json");

    if (!response.ok) {
      throw new Error("Could not load planets.json (" + response.status + ").");
    }

    const data = await response.json();

    validateStyles(data);
    objectStyles = data;
    objectTypes = data.types;

    generateObject();
    resizeScene();

    lastFrameTime = performance.now();

    requestAnimationFrame(animate);
  } catch (error) {
    console.error(error);

    objectStyles = null;

    loadError.hidden = false;
    loadError.textContent = "Unable to load planet styles. Open the project with a local server, then try again.";
  } finally {
    generateButton.disabled = false;
  }
}


/********************
* OBJECT GENERATION *
********************/

function selectObjectType() {
  let totalWeight = 0;

  for (const objectType of objectTypes) {
    totalWeight += objectType.weight;
  }

  let randomWeight = Math.random() * totalWeight;

  for (const objectType of objectTypes) {
    randomWeight -= objectType.weight;
    if (randomWeight < 0) {
      return objectType;
    }
  }

  return objectTypes[objectTypes.length - 1];
}

function createCraters(objectType) {
  const craters = [];

  if (objectType !== "rocky") {
    return craters;
  }

  for (let craterIndex = 0; craterIndex < 26; craterIndex++) {
    const latitude = randomFloat(-1, 1);
    const longitude = randomFloat(0, Math.PI * 2);
    const latitudeRadius = Math.sqrt(1 - latitude * latitude);

    craters.push({
      x: Math.cos(longitude) * latitudeRadius,
      y: latitude,
      z: Math.sin(longitude) * latitudeRadius,
      radius: randomFloat(0.06, 0.2)
    });
  }
  return craters;
}


/******************
* STELLAR SURFACE *
******************/

function drawStar(imageData) {
  const palette = celestialObject.palette;
  const starRadius = celestialObject.radius;
  const coronaRadius = starRadius + 22;

  for (let pixelY = Math.floor(RENDER_CENTER_Y - coronaRadius); pixelY <= RENDER_CENTER_Y + coronaRadius; pixelY++) {
    for (let pixelX = Math.floor(RENDER_CENTER_X - coronaRadius); pixelX <= RENDER_CENTER_X + coronaRadius; pixelX++) {
      const offsetX = pixelX + 0.5 - RENDER_CENTER_X;
      const offsetY = pixelY + 0.5 - RENDER_CENTER_Y;
      const distance = Math.hypot(offsetX, offsetY);

      if (distance > coronaRadius) {
        continue;
      }

      if (distance > starRadius) {
        const angle = Math.atan2(offsetY, offsetX);
        const prominence = fbm3(Math.cos(angle) * 2, Math.sin(angle) * 2, animationTime * 0.14, celestialObject.seed + 50, 3, 0.7);
        const coronaLength = 5 + prominence * 19;
        const altitude = distance - starRadius;
        const glow = Math.exp(-altitude / 4.8) * 0.32;

        let flame = clamp(1 - altitude / coronaLength, 0, 1);

        flame = Math.pow(flame, 3) * (0.3 + prominence * 0.7);

        const opacity = Math.min(0.8, glow + flame);
        const color = mixColor(palette[0], palette[2], flame);

        blendPixel(imageData, pixelX, pixelY, color, Math.round(opacity * 255));

        continue;
      }
      const normal = spherePoint(pixelX + 0.5, pixelY + 0.5, starRadius);

      if (!normal) {
        continue;
      }

      const surfacePoint = rotateY(normal, rotationAngle);
      const convection = fbm3(surfacePoint.x, surfacePoint.y, surfacePoint.z + animationTime * 0.035, celestialObject.seed, 4, 0.22);
      const granulation = valueNoise3(surfacePoint.x * 27, surfacePoint.y * 27, surfacePoint.z * 27 + animationTime * 0.25, celestialObject.seed + 800);
      const intensity = clamp(convection * 0.75 + granulation * 0.25, 0, 0.999);
      const palettePosition = 1 + intensity * 3;
      const paletteIndex = Math.min(3, Math.floor(palettePosition));

      let color = mixColor(palette[paletteIndex], palette[paletteIndex + 1], palettePosition - paletteIndex);

      // Emissive surface: the pointer light should not darken a star.
      color = darken(color, 0.72 + normal.z * 0.28);
      setPixel(imageData, pixelX, pixelY, color, 255);
    }
  }
}


/***********************
* BLACK HOLE ACCRETION *
***********************/

function drawAccretionDisk(imageData, foreground) {
  const palette = celestialObject.palette;
  const outerRadius = celestialObject.radius * 2.9;
  const innerRadius = celestialObject.radius * 1.3;
  const tilt = 0.23;
  const rotation = -0.13;
  const rotationCosine = Math.cos(rotation);
  const rotationSine = Math.sin(rotation);

  for (let pixelY = 0; pixelY < RENDER_HEIGHT; pixelY++) {
    for (let pixelX = 0; pixelX < RENDER_WIDTH; pixelX++) {
      const offsetX = pixelX + 0.5 - RENDER_CENTER_X;
      const offsetY = pixelY + 0.5 - RENDER_CENTER_Y;
      const diskX = offsetX * rotationCosine - offsetY * rotationSine;
      const diskY = offsetX * rotationSine + offsetY * rotationCosine;

      if (foreground && diskY < 0) {
        continue;
      }

      if (!foreground && diskY >= 0) {
        continue;
      }

      const diskRadius = Math.hypot(diskX, diskY / tilt);

      if (diskRadius < innerRadius || diskRadius > outerRadius) {
        continue;
      }

      const angle = Math.atan2(diskY / tilt, diskX);
      const radialPosition = (diskRadius - innerRadius) / (outerRadius - innerRadius);
      const flow = 0.5 + 0.5 * Math.sin(diskRadius * 1.3 + angle * 3 - animationTime * 1.8);
      const brightness = clamp(1 - radialPosition * 0.7 + flow * 0.12, 0, 1);

      let color = mixColor(palette[1], palette[4], brightness * brightness);
      color = darken(color, 0.75 + 0.25 * (diskX / outerRadius + 1) / 2);

      let opacity = clamp((1 - radialPosition) * 4, 0, 1) * (0.72 + flow * 0.22);
      opacity *= clamp((diskRadius - innerRadius) / 2, 0, 1);

      blendPixel(imageData, pixelX, pixelY, color, Math.round(opacity * 255));
    }
  }
}

function drawBlackHole(imageData) {
  const horizonRadius = celestialObject.radius;
  const palette = celestialObject.palette;

  drawAccretionDisk(imageData, false);

  for (let pixelY = 0; pixelY < RENDER_HEIGHT; pixelY++) {
    for (let pixelX = 0; pixelX < RENDER_WIDTH; pixelX++) {
      const offsetX = pixelX + 0.5 - RENDER_CENTER_X;
      const offsetY = pixelY + 0.5 - RENDER_CENTER_Y;
      const distance = Math.hypot(offsetX, offsetY);

      // Stylized lensed rear disk, visible as an arc above the horizon.
      const lensedDistance = Math.hypot(offsetX / 1.24, offsetY);
      const arcDistance = Math.abs(lensedDistance - horizonRadius * 1.2);

      if (offsetY < 0 && arcDistance < 5) {
        const arcOpacity = Math.exp(-arcDistance * 0.85) * 0.86;
        blendPixel(imageData, pixelX, pixelY, palette[3], Math.round(arcOpacity * 255));
      }

      const photonDistance = Math.abs(distance - horizonRadius * 1.035);

      if (photonDistance < 7) {
        const glowOpacity = Math.exp(-photonDistance * 0.7) * 0.8;
        blendPixel(imageData, pixelX, pixelY, palette[2], Math.round(glowOpacity * 255));
      }

      if (distance < horizonRadius) {
        setPixel(imageData, pixelX, pixelY, celestialObject.type.surfaceColors.horizon, 255);
      }
    }
  }
  drawAccretionDisk(imageData, true);
}


/***************************
* TOUCH AND KEYBOARD INPUT *
***************************/

let activeTouchPointerId = null;

function isInteractiveTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  return target.isContentEditable || target.closest("button, a, input, select, textarea, [role='button']") !== null;
}

function startLightDrag(event) {
  if (event.pointerType === "mouse" || activeTouchPointerId !== null) {
    return;
  }

  if (!event.isPrimary || isInteractiveTarget(event.target)) {
    return;
  }

  activeTouchPointerId = event.pointerId;

  displayCanvas.setPointerCapture(event.pointerId);
  updateLightFromPointer(event);
}

function moveLightPointer(event) {
  if (event.pointerType === "mouse") {
    if (activeTouchPointerId === null && !isInteractiveTarget(event.target)) {
      updateLightFromPointer(event);
    }
    return;
  }

  if (event.pointerId === activeTouchPointerId) {
    updateLightFromPointer(event);
  }
}

function stopLightDrag(event) {
  if (event.pointerId !== activeTouchPointerId) {
    return;
  }

  activeTouchPointerId = null;

  if (displayCanvas.hasPointerCapture(event.pointerId)) {
    displayCanvas.releasePointerCapture(event.pointerId);
  }
}

function generateWithKeyboard(event) {
  if (event.code !== "Space" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
    return;
  }

  // Keep native keyboard behavior for focused buttons, links and form fields.
  if (isInteractiveTarget(event.target)) {
    return;
  }

  event.preventDefault();

  if (event.repeat) {
    return;
  }

  generateButton.click();
}


/*******************
* EVENTS AND START *
*******************/

displayCanvas.addEventListener("pointerdown", startLightDrag);
window.addEventListener("pointermove", moveLightPointer);
window.addEventListener("pointerup", stopLightDrag);
window.addEventListener("pointercancel", stopLightDrag);
displayCanvas.addEventListener("lostpointercapture", stopLightDrag);
window.addEventListener("keydown", generateWithKeyboard);

generateButton.addEventListener("click", function () {
  if (!objectStyles) {
    initialize();
    return;
  }
  generateObject();

});
window.addEventListener("resize", resizeScene);

document.addEventListener("visibilitychange", function () {
  lastFrameTime = performance.now();
});

resizeScene();
initialize();
