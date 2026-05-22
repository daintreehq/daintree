{
  "targets": [
    {
      "target_name": "daintree_pty_supervisor",
      "conditions": [
        ["OS!=\"win\"", {
          "type": "executable",
          "sources": [ "src/supervisor.c" ],
          "cflags": [ "-std=c11", "-O2", "-Wall" ],
          "xcode_settings": {
            "GCC_C_LANGUAGE_STANDARD": "c11",
            "OTHER_CFLAGS": [ "-O2", "-Wall" ]
          }
        }],
        ["OS==\"win\"", {
          "type": "none"
        }]
      ]
    }
  ]
}
