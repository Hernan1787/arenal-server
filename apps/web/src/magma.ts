// Fondo de magma: un shader de ruido que se mueve despacio, dibujado a baja resolución y escalado
// sin suavizar (píxeles grandes). El calor sube con la presión del volcán. Sin WebGL, o con
// «reducir movimiento», queda un degradado fijo de CSS.

const VERTEX = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 res;
uniform float t;
uniform float heat;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / res.y;
  vec2 q = vec2(fbm(uv * 1.6 + t * 0.03), fbm(uv * 1.6 - t * 0.025 + 3.1));
  float n = fbm(uv * 2.2 + 2.4 * q + vec2(0.0, -t * 0.05));
  // Vetas: donde el ruido cruza un umbral aparece el magma; con más calor, más vetas.
  float vein = smoothstep(0.62 - heat * 0.12, 0.70, n) * (0.55 + heat * 0.45);
  vec3 night = vec3(0.071, 0.051, 0.110);
  vec3 dusk = vec3(0.180, 0.090, 0.250);
  vec3 lava = vec3(1.0, 0.31, 0.12);
  vec3 ember = vec3(1.0, 0.75, 0.23);
  vec3 col = mix(night, dusk, smoothstep(0.25, 0.75, n));
  col = mix(col, lava, vein);
  col = mix(col, ember, vein * smoothstep(0.72, 0.80, n));
  // Más oscuro arriba, como un cielo de noche.
  col *= 0.55 + 0.45 * (1.0 - gl_FragCoord.y / res.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface Magma {
  setHeat(heat: number): void;
}

const PIXEL = 6;

export function startMagma(canvas: HTMLCanvasElement, reducedMotion: boolean): Magma {
  const gl = canvas.getContext('webgl', { antialias: false });
  if (gl === null) {
    canvas.classList.add('magma--fallback');
    return { setHeat: () => undefined };
  }

  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('No se pudo crear el shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    canvas.classList.add('magma--fallback');
    return { setHeat: () => undefined };
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const resLoc = gl.getUniformLocation(program, 'res');
  const timeLoc = gl.getUniformLocation(program, 't');
  const heatLoc = gl.getUniformLocation(program, 'heat');

  let heat = 0;
  let shownHeat = 0;
  const started = performance.now();

  const resize = (): void => {
    canvas.width = Math.max(1, Math.ceil(window.innerWidth / PIXEL));
    canvas.height = Math.max(1, Math.ceil(window.innerHeight / PIXEL));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const draw = (now: number): void => {
    // El calor se acerca al valor nuevo poco a poco, así un cambio no salta de golpe.
    shownHeat += (heat - shownHeat) * 0.05;
    gl.uniform2f(resLoc, canvas.width, canvas.height);
    gl.uniform1f(timeLoc, reducedMotion ? 12 : (now - started) / 1000);
    gl.uniform1f(heatLoc, shownHeat);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  resize();
  window.addEventListener('resize', () => {
    resize();
    draw(performance.now());
  });

  if (reducedMotion) {
    draw(performance.now());
    return {
      setHeat(value) {
        heat = value;
        shownHeat = value;
        draw(performance.now());
      },
    };
  }

  let last = 0;
  const loop = (now: number): void => {
    // Unos 30 cuadros por segundo bastan y no gastan batería de más.
    if (now - last > 33) {
      last = now;
      draw(now);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return {
    setHeat(value) {
      heat = value;
    },
  };
}
