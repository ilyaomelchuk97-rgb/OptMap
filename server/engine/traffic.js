// Модель дорожной загрузки («пробки»).
//
// Время на участке дороги = длина / (ограничение скорости × коэффициент загрузки).
// Коэффициент зависит от класса дороги и часа выезда (будни/выходные).
// Значение 1.0 — свободный поток, 0.5 — скорость падает вдвое.
//
// Профиль можно переопределить своим JSON-файлом (TRAFFIC_PROFILE_PATH в .env),
// а в перспективе — заменить TrafficModel на загрузку реальных данных
// (интерфейс: factor(group, hour, isWeekend)).

export const ROAD_CLASS_GROUP = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'motorway',
  trunk_link: 'motorway',
  primary: 'arterial',
  primary_link: 'arterial',
  secondary: 'arterial',
  secondary_link: 'arterial',
  tertiary: 'local',
  tertiary_link: 'local',
  unclassified: 'local',
  residential: 'local',
  living_street: 'local',
  service: 'local',
  road: 'local',
};

// Профиль по умолчанию: утренний пик ~8:00, вечерний ~17–18:00.
// Магистрали держатся дольше, местные улицы «встают» сильнее и раньше.
export const DEFAULT_PROFILE = {
  weekday: {
    //      0ч   1    2    3    4    5    6    7    8    9    10   11   12   13   14   15   16   17   18   19   20   21   22   23
    motorway: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.95, 0.82, 0.72, 0.78, 0.86, 0.9, 0.92, 0.9, 0.88, 0.84, 0.74, 0.64, 0.62, 0.72, 0.84, 0.93, 1.0, 1.0],
    arterial: [1.0, 1.0, 1.0, 1.0, 1.0, 0.98, 0.88, 0.62, 0.5, 0.6, 0.75, 0.83, 0.85, 0.82, 0.8, 0.72, 0.55, 0.46, 0.48, 0.62, 0.78, 0.9, 0.97, 1.0],
    local:    [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.92, 0.7, 0.58, 0.66, 0.78, 0.85, 0.87, 0.84, 0.82, 0.76, 0.62, 0.52, 0.55, 0.68, 0.82, 0.93, 1.0, 1.0],
  },
  weekend: {
    motorway: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.98, 0.94, 0.9, 0.86, 0.83, 0.82, 0.83, 0.85, 0.87, 0.88, 0.86, 0.83, 0.85, 0.9, 0.95, 1.0, 1.0],
    arterial: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.96, 0.9, 0.82, 0.75, 0.7, 0.68, 0.7, 0.72, 0.75, 0.78, 0.76, 0.72, 0.74, 0.82, 0.92, 0.98, 1.0],
    local:    [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.98, 0.93, 0.86, 0.8, 0.76, 0.74, 0.76, 0.78, 0.8, 0.82, 0.8, 0.76, 0.78, 0.85, 0.94, 1.0, 1.0],
  },
};

export class TrafficModel {
  constructor(profile = DEFAULT_PROFILE) {
    this.profile = profile;
    // минимальный коэффициент по всем группам/часам — для допустимой эвристики A*
    let min = 1;
    for (const day of ['weekday', 'weekend']) {
      for (const g of ['motorway', 'arterial', 'local']) {
        for (const f of profile[day][g]) min = Math.min(min, f);
      }
    }
    this.minFactor = min;
    this.maxFactor = 1;
  }

  group(cls) {
    return ROAD_CLASS_GROUP[cls] || 'local';
  }

  /** Множитель скорости на дороге группы group в час hour (0–23). */
  factor(group, hour, isWeekend) {
    const day = isWeekend ? this.profile.weekend : this.profile.weekday;
    const arr = day[group] || day.local;
    const f = arr[((hour % 24) + 24) % 24];
    return Math.max(0.15, Math.min(1.15, f));
  }

  /** Человекочитаемое описание профиля — для UI/ответов API. */
  describe(date = new Date()) {
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    return {
      type: 'time-of-day-model',
      isWeekendNow: isWeekend,
      peaks: isWeekend ? [] : [
        { hours: [8, 10], label: 'утренний час пик' },
        { hours: [17, 19], label: 'вечерний час пик' },
      ],
      range: { best: '23:00–05:00', worst: '08:00–09:00, 17:00–18:00 (будни)' },
    };
  }
}
