/** 芯片/科技企业宣传片 分镜提示词模板 */

export const chipPromoTemplates = [
  {
    category: '芯片制造',
    templates: [
      {
        label: '晶圆光刻特写',
        prompt: 'Extreme macro close-up of a 300mm silicon wafer under DUV photolithography, nanometer-scale circuit patterns, electric blue light beams, ultra-clean fab environment, photoresist texture, volumetric lighting, photorealistic 8K, cinematic depth of field',
        promptZh: '300mm硅晶圆DUV光刻微距特写，纳米级电路图案，电蓝色光束，超净间环境，光刻胶纹理，体积光，超写实8K',
      },
      {
        label: '光刻车间全景',
        prompt: 'Wide cinematic shot of a semiconductor photolithography bay, rows of EUV lithography machines, amber yellow cleanroom lighting, robotic wafer handling arms, overhead track system, ultra-clean ISO class 1 environment, volumetric god rays, photorealistic 8K',
        promptZh: '半导体光刻车间电影级全景，成排EUV光刻机，琥珀色超净间灯光，机械臂传送晶圆，空中轨道系统，ISO 1级洁净环境，体积光，超写实8K',
      },
      {
        label: '晶圆微观剖面',
        prompt: 'Cross-section electron microscope view inside a 5nm advanced chip, multiple metal interconnect layers, copper traces in blue and gold, transistor gates visible at atomic scale, abstract scientific visualization, dark background, cinematic 8K',
        promptZh: '5nm先进芯片电子显微镜剖面图，多层金属互连，铜导线蓝金色，原子级晶体管栅极可见，抽象科学可视化，深色背景，电影级8K',
      },
      {
        label: '自动化封装产线',
        prompt: 'Fully automated chip packaging line, precision die-bonding machines, gold wire bonding under microscope, conveyor belt with chips in trays, clean white industrial environment, machine vision cameras, photorealistic 8K, sharp focus',
        promptZh: '全自动芯片封装产线，精密固晶机，显微镜下金线键合，传送带上托盘芯片，洁净白色工业环境，机器视觉摄像头，超写实8K',
      },
    ],
  },
  {
    category: '抽象概念',
    templates: [
      {
        label: '数据流动背景',
        prompt: 'Abstract flowing digital background, blue and cyan data streams flowing through dark space, binary code particles, fiber optic light beams intersecting, clean composition with negative space for text, premium corporate tech aesthetic, 8K, 16:9',
        promptZh: '抽象数字化流动背景，蓝青色数据流穿越暗空间，二进制粒子，光纤光束交错，干净构图留白给文字，高端企业科技美学，8K，16:9',
      },
      {
        label: '芯片能量核心',
        prompt: 'A glowing AI processor chip at center, radiating concentric blue energy rings, golden contact pads, circuit traces extending outward like neural networks, dark gradient background, clean minimal composition, sci-fi corporate style, 8K',
        promptZh: '发光AI处理器芯片居中，辐射同心蓝色能量环，金色触点，电路纹路像神经网络向外延伸，深色渐变背景，干净极简构图，科幻企业风格，8K',
      },
      {
        label: '科技网格背景',
        prompt: 'Minimal tech grid background, subtle hexagonal mesh, soft blue glow at intersections, dark gradient from deep navy to black, large negative space for text overlay, clean corporate presentation style, 8K, 16:9',
        promptZh: '极简科技网格背景，细微六边形网格，交点柔蓝光，深海军蓝到黑渐变，大面积留白给文字，干净企业演示风格，8K，16:9',
      },
      {
        label: '量子计算视觉',
        prompt: 'Abstract quantum computing visualization, glowing qubit states in superposition, blue and gold energy lattice, particle entanglement effects, futuristic lab environment, ethereal volumetric light, sci-fi documentary style, 8K',
        promptZh: '抽象量子计算可视化，叠加态量子比特发光，蓝金色能量晶格，粒子纠缠效果，未来实验室环境，空灵体积光，科幻纪录片风格，8K',
      },
    ],
  },
  {
    category: '产品展示',
    templates: [
      {
        label: 'STM32芯片特写',
        prompt: 'Product photography of an STM32 microcontroller chip on a dark reflective surface, the silkscreen STM32 logo clearly visible, golden pins, subtle blue LED indicator glow, premium tech product shot, crisp details, 8K, studio lighting',
        promptZh: 'STM32微控制器芯片产品摄影，暗色反射表面，丝印STM32标志清晰可见，金色引脚，蓝色LED指示灯微光，高端科技产品拍摄，锐利细节，8K，影棚灯光',
      },
      {
        label: '开发板桌面场景',
        prompt: 'Clean desk setup with a microcontroller development board connected to oscilloscope probes, laptop screen showing code in background, warm desk lamp lighting, modern maker workspace aesthetic, shallow depth of field, photorealistic 8K',
        promptZh: '干净桌面场景，微控制器开发板连接示波器探头，背景笔记本屏幕显示代码，台灯暖光，现代创客工作空间美学，浅景深，超写实8K',
      },
      {
        label: '芯片在手中',
        prompt: 'A tiny microchip held between thumb and forefinger against a clean white background, showing scale and precision engineering, soft natural lighting, macro photography, minimal composition, product showcase style, 8K',
        promptZh: '拇指和食指间夹着微型芯片，纯白背景，展示尺寸和精密工程，柔和自然光，微距摄影，极简构图，产品展示风格，8K',
      },
      {
        label: '芯片散热器',
        prompt: 'Industrial cooler master heatsink with copper heat pipes and aluminum fins, mounted on a processor, dramatic rim lighting revealing texture details, dark background, product hero shot, photorealistic 8K',
        promptZh: '工业级散热器，铜质热管铝合金鳍片，安装在处理器上，戏剧性轮廓光揭示纹理细节，深色背景，产品英雄镜头，超写实8K',
      },
    ],
  },
]

/** 根据分类和标签查找模板 */
export function findChipTemplate(category, label) {
  const cat = chipPromoTemplates.find(c => c.category === category)
  if (!cat) return null
  return cat.templates.find(t => t.label === label) || null
}
