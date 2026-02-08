{
  "name": "Complex Multi-Set Test",
  "description": "A complex motion profile with multiple sets, move types, and executions",
  "sets": [
    {
      "name": "Conditioning Cycles",
      "executions": 2,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "relative",
          "moveParameters": {
            "position": 0,
            "velocity": 5,
            "distance": 10,
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
            "velocity": 5,
            "distance": -10,
            "time": 0,
            "circularOffset": 0
          }
        }
      ]
    },
    {
      "name": "Main Test",
      "executions": 1,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 30,
            "velocity": 2,
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
            "time": 1000,
            "circularOffset": 0
          }
        },
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 0,
            "velocity": 5,
            "distance": 0,
            "time": 0,
            "circularOffset": 0
          }
        }
      ]
    }
  ]
}
