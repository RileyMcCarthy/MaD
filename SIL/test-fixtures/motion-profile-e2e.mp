{
  "name": "E2E Full Coverage Test",
  "description": "Exercises all move types: linear absolute, linear relative, dwell, multiple sets, multiple executions",
  "sets": [
    {
      "name": "Conditioning",
      "executions": 2,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "relative",
          "moveParameters": {
            "position": 0,
            "velocity": 10,
            "distance": 5,
            "time": 0,
            "circularOffset": 0
          }
        },
        {
          "moveType": "dwell",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 0,
            "velocity": 0,
            "distance": 0,
            "time": 200,
            "circularOffset": 0
          }
        },
        {
          "moveType": "linear",
          "absoluteOrRelative": "relative",
          "moveParameters": {
            "position": 0,
            "velocity": 10,
            "distance": -5,
            "time": 0,
            "circularOffset": 0
          }
        }
      ]
    },
    {
      "name": "Main Ramp",
      "executions": 1,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 15,
            "velocity": 5,
            "distance": 0,
            "time": 0,
            "circularOffset": 0
          }
        },
        {
          "moveType": "dwell",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 0,
            "velocity": 0,
            "distance": 0,
            "time": 500,
            "circularOffset": 0
          }
        },
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 0,
            "velocity": 10,
            "distance": 0,
            "time": 0,
            "circularOffset": 0
          }
        }
      ]
    }
  ]
}
