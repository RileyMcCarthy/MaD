{
  "name": "Fractional Position Precision Test",
  "description": "Exercises sub-mm targets to verify encoder/sample precision",
  "sets": [
    {
      "name": "Fractional Moves",
      "executions": 1,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 2.5,
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
            "time": 200,
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
