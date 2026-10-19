{
  "targets": [
    {
      "target_name": "mac_phys_footprint",
      "conditions": [
        ["OS==\"mac\"", {
          "sources": [ "src/mac_phys_footprint.cc" ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
          }
        }],
        ["OS!=\"mac\"", {
          "type": "none"
        }]
      ]
    }
  ]
}
