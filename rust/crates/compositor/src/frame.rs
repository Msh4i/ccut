use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// `rename_all` alone renames the variants only; the fields of `SceneEffect` need
// `rename_all_fields`, or the effect-track Blur reads `effect_pass_groups`.
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    SceneEffect {
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    pub mask: Option<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    /// Row-major 3x3 map from the layer texture's UV square ([0, 1]^2, u right,
    /// v down) to canvas pixels, scaled so that the third component w is > 0
    /// for points in front of the camera (3D layers). When present the shader
    /// places the layer with it and ignores the fields above, which still carry
    /// the layer's 2D bounding box for tools. Absent in 2D descriptors.
    #[serde(default)]
    pub homography: Option<[f32; 9]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTextureDescriptor {
    pub id: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde::de::{
        self, IntoDeserializer, Visitor,
        value::{Error as ValueError, MapDeserializer, SeqDeserializer},
    };

    use super::QuadTransformDescriptor;

    /// A minimal self-describing value, so descriptors can be deserialized in
    /// tests the way `serde_wasm_bindgen` does it, without a JSON dependency.
    #[derive(Clone)]
    enum Value {
        Number(f32),
        Bool(bool),
        List(Vec<f32>),
    }

    struct ValueDeserializer(Value);

    impl<'de> IntoDeserializer<'de, ValueError> for Value {
        type Deserializer = ValueDeserializer;

        fn into_deserializer(self) -> ValueDeserializer {
            ValueDeserializer(self)
        }
    }

    impl<'de> de::Deserializer<'de> for ValueDeserializer {
        type Error = ValueError;

        fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ValueError> {
            match self.0 {
                Value::Number(number) => visitor.visit_f32(number),
                Value::Bool(flag) => visitor.visit_bool(flag),
                Value::List(items) => visitor.visit_seq(SeqDeserializer::new(items.into_iter())),
            }
        }

        fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ValueError> {
            visitor.visit_some(self)
        }

        serde::forward_to_deserialize_any! {
            bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
            bytes byte_buf unit unit_struct newtype_struct seq tuple
            tuple_struct map struct enum identifier ignored_any
        }
    }

    fn quad_fields() -> Vec<(&'static str, Value)> {
        vec![
            ("centerX", Value::Number(320.0)),
            ("centerY", Value::Number(180.0)),
            ("width", Value::Number(640.0)),
            ("height", Value::Number(360.0)),
            ("rotationDegrees", Value::Number(15.0)),
            ("flipX", Value::Bool(true)),
            ("flipY", Value::Bool(false)),
        ]
    }

    fn deserialize_quad(
        fields: Vec<(&'static str, Value)>,
    ) -> Result<QuadTransformDescriptor, ValueError> {
        QuadTransformDescriptor::deserialize(MapDeserializer::<_, ValueError>::new(
            fields.into_iter(),
        ))
    }

    #[test]
    fn a_2d_descriptor_without_homography_still_deserializes() {
        let quad = deserialize_quad(quad_fields()).expect("2D quad deserializes");
        assert_eq!(quad.center_x, 320.0);
        assert_eq!(quad.center_y, 180.0);
        assert_eq!(quad.width, 640.0);
        assert_eq!(quad.height, 360.0);
        assert_eq!(quad.rotation_degrees, 15.0);
        assert!(quad.flip_x);
        assert!(!quad.flip_y);
        assert_eq!(quad.homography, None);
    }

    #[test]
    fn a_homography_is_read_row_major() {
        let mut fields = quad_fields();
        let matrix = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        fields.push(("homography", Value::List(matrix)));
        let quad = deserialize_quad(fields).expect("3D quad deserializes");
        assert_eq!(
            quad.homography,
            Some([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0])
        );
    }

    /// The editor sends camelCase keys everywhere (`effectPassGroups`), also in
    /// a scene-effect item: the effect-track Blur is that item.
    #[test]
    fn a_scene_effect_item_reads_camel_case_keys() {
        let json = r#"{
            "width": 4, "height": 4, "clear": { "color": [0, 0, 0, 0] },
            "items": [{
                "type": "sceneEffect",
                "effectPassGroups": [[{
                    "shader": "gaussian-blur",
                    "uniforms": { "u_sigma": 2, "u_step": 1, "u_direction": [1, 0] }
                }]]
            }]
        }"#;
        let frame: super::FrameDescriptor =
            serde_json::from_str(json).expect("a scene-effect frame deserializes");
        match &frame.items[..] {
            [super::FrameItemDescriptor::SceneEffect { effect_pass_groups }] => {
                assert_eq!(effect_pass_groups.len(), 1);
                assert_eq!(effect_pass_groups[0][0].shader, "gaussian-blur");
            }
            other => panic!("expected one scene-effect item, got {other:?}"),
        }
    }

    /// The same file `frame-descriptor-effects.test.ts` compares the editor's own
    /// output with: a clip blur and an effect-track blur in one frame.
    #[test]
    fn the_shared_fixture_deserializes() {
        let frame: super::FrameDescriptor =
            serde_json::from_str(include_str!("../tests/fixtures/blur-frame.json"))
                .expect("the shared fixture deserializes");
        assert_eq!(frame.items.len(), 2);
        assert!(matches!(
            &frame.items[0],
            super::FrameItemDescriptor::Layer(layer) if layer.effect_pass_groups.len() == 1
        ));
        assert!(matches!(
            &frame.items[1],
            super::FrameItemDescriptor::SceneEffect { effect_pass_groups }
                if effect_pass_groups.len() == 1
        ));
    }

    /// Layers already worked: a layer item with camelCase keys must keep doing so.
    #[test]
    fn a_layer_item_reads_camel_case_keys() {
        let json = r#"{
            "width": 4, "height": 4, "clear": { "color": [0, 0, 0, 0] },
            "items": [{
                "type": "layer", "textureId": "t", "opacity": 1, "blendMode": "normal",
                "transform": { "centerX": 2, "centerY": 2, "width": 4, "height": 4,
                    "rotationDegrees": 0, "flipX": false, "flipY": false },
                "effectPassGroups": [[{ "shader": "gaussian-blur", "uniforms": {} }]],
                "mask": null
            }]
        }"#;
        let frame: super::FrameDescriptor =
            serde_json::from_str(json).expect("a layer frame deserializes");
        match &frame.items[..] {
            [super::FrameItemDescriptor::Layer(layer)] => {
                assert_eq!(layer.effect_pass_groups.len(), 1);
            }
            other => panic!("expected one layer item, got {other:?}"),
        }
    }

    #[test]
    fn a_homography_of_the_wrong_length_is_rejected() {
        let mut fields = quad_fields();
        fields.push(("homography", Value::List(vec![1.0, 2.0, 3.0])));
        assert!(deserialize_quad(fields).is_err());
    }
}
