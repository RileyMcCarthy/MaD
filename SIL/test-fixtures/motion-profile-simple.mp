{
  "name": "Simple Tension Test",
  "description": "A simple linear tension test for SIL testing",
  "sets": [
    {
      "name": "Tension Cycle",
      "executions": 1,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 20,
            "velocity": 10,
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
