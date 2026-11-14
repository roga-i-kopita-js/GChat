import './tokens.css';
import './WinterWeather.css';

import { Snowflake } from 'lucide-react';
import type { CSSProperties, JSX } from 'react';
import { useEffect, useState } from 'react';

// Static placement and phases from the approved preview; CSS owns all motion.
const flakes = [
  [2, 16, 24, -4, 0.48, 12],
  [93, 14, 28, -19, 0.4, 24],
  [3, 13, 31, -14, 0.36, 38],
  [92, 17, 26, -9, 0.46, 53],
  [1, 14, 29, -23, 0.34, 68],
  [94, 15, 32, -12, 0.42, 81],
  [2, 17, 30, -27, 0.44, 91],
  [93, 13, 25, -2, 0.36, 7],
  [48, 14, 34, -28, 0.22, 97],
  [72, 13, 27, -24, 0.24, 95],
];

type WeatherStyle = CSSProperties & Record<`--weather-${string}`, string | number>;

export function WinterWeather(): JSX.Element {
  const [paused, setPaused] = useState(document.hidden);

  useEffect((): (() => void) => {
    const update = (): void => setPaused(document.hidden);

    document.addEventListener('visibilitychange', update);
    update();

    return (): void => document.removeEventListener('visibilitychange', update);
  }, []);

  return (
    <div className="winter-weather" aria-hidden="true" data-paused={paused}>
      {flakes.map(([x, size, duration, delay, opacity, rest], index): JSX.Element => {
        const style: WeatherStyle = {
          '--weather-index': index,
          '--weather-x': `${x}%`,
          '--weather-size': `calc(var(--ui-snow-size) * ${size / 15})`,
          '--weather-duration': `calc(var(--ui-snow-fall-duration) * ${duration / 30})`,
          '--weather-delay': `calc(var(--ui-snow-fall-duration) * ${delay / 30})`,
          '--weather-opacity': opacity,
          '--weather-rest': `${rest}%`,
        };

        return (
          <span key={index} className="winter-flake" style={style}>
            <span className="winter-flake-drift">
              <Snowflake />
            </span>
          </span>
        );
      })}
    </div>
  );
}
