// Sample groups and timetables shown to clubs while they preview the app.
const SAMPLE_SQUADS = [
  {
    "id": 1,
    "name": "Development Squad",
    "level": "Ages 7–10 · Learn-to-squad",
    "description": "Stroke technique and confidence in deep water.",
    "location": "Main Pool",
    "capacity": 16,
    "coach": "Head Coach",
    "weekly": 25.5,
    "fortnightly": 51,
    "monthly": 100,
    "pass": 130,
    "sessions": [
      {
        "id": "dev-mon",
        "seriesId": "dev-mon",
        "day": 1,
        "start": "17:00",
        "end": "18:00",
        "location": "Main Pool, Lanes 1–2",
        "startsOn": null,
        "endsOn": null,
        "cancellations": [
          {
            "date": "2026-10-26",
            "reason": "Labour Day"
          }
        ]
      },
      {
        "id": "dev-wed",
        "seriesId": "dev-wed",
        "day": 3,
        "start": "17:00",
        "end": "18:00",
        "location": "Main Pool, Lanes 1–2",
        "startsOn": null,
        "endsOn": "2026-11-03",
        "cancellations": []
      },
      {
        "id": "dev-wed-2",
        "seriesId": "dev-wed",
        "day": 3,
        "start": "17:30",
        "end": "18:30",
        "location": "Main Pool, Lanes 1–2",
        "startsOn": "2026-11-04",
        "endsOn": null,
        "cancellations": []
      },
      {
        "id": "dev-sat",
        "seriesId": "dev-sat",
        "day": 6,
        "start": "08:00",
        "end": "09:00",
        "location": "Main Pool, Lanes 1–3",
        "startsOn": null,
        "endsOn": null,
        "cancellations": []
      }
    ]
  },
  {
    "id": 2,
    "name": "Bronze Squad",
    "level": "Ages 10–13 · Competitive",
    "description": "Race skills, starts and turns. Club meets each term.",
    "location": "Main Pool",
    "capacity": 20,
    "coach": "Head Coach",
    "weekly": 31.5,
    "fortnightly": 63,
    "monthly": 125,
    "pass": 150,
    "sessions": [
      {
        "id": "brz-tue",
        "seriesId": "brz-tue",
        "day": 2,
        "start": "17:00",
        "end": "18:15",
        "location": "Main Pool, Lanes 3–4",
        "startsOn": null,
        "endsOn": null,
        "cancellations": []
      },
      {
        "id": "brz-thu",
        "seriesId": "brz-thu",
        "day": 4,
        "start": "17:00",
        "end": "18:15",
        "location": "Main Pool, Lanes 3–4",
        "startsOn": null,
        "endsOn": null,
        "cancellations": []
      },
      {
        "id": "brz-sat",
        "seriesId": "brz-sat",
        "day": 6,
        "start": "09:00",
        "end": "10:30",
        "location": "Main Pool, Lanes 3–4",
        "startsOn": null,
        "endsOn": null,
        "cancellations": [
          {
            "date": "2026-10-24",
            "reason": "Pool maintenance"
          }
        ]
      }
    ]
  },
  {
    "id": 3,
    "name": "Endurance Squad",
    "level": "Ages 13+ · Distance & open water",
    "description": "Aerobic base, distance sets and open-water prep.",
    "location": "Main Pool",
    "capacity": 14,
    "coach": "Head Coach",
    "weekly": 25.2,
    "fortnightly": 50.4,
    "monthly": 100.8,
    "pass": 130,
    "sessions": [
      {
        "id": "end-mon",
        "seriesId": "end-mon",
        "day": 1,
        "start": "05:30",
        "end": "07:00",
        "location": "Main Pool, Lanes 5–6",
        "startsOn": null,
        "endsOn": null,
        "cancellations": []
      },
      {
        "id": "end-wed",
        "seriesId": "end-wed",
        "day": 3,
        "start": "05:30",
        "end": "07:00",
        "location": "Main Pool, Lanes 5–6",
        "startsOn": null,
        "endsOn": null,
        "cancellations": []
      },
      {
        "id": "end-fri",
        "seriesId": "end-fri",
        "day": 5,
        "start": "05:30",
        "end": "07:00",
        "location": "Main Pool, Lanes 5–6",
        "startsOn": null,
        "endsOn": null,
        "cancellations": []
      }
    ]
  }
];

export default SAMPLE_SQUADS;
