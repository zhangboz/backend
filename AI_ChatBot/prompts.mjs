// Preserved from agent/homework_help{_zh}/prompt.py and agent.py, and
// agent/HandWritten_to_Markdown/prompt.py. Only the ADK state placeholder
// {image_answer} is replaced with the preceding response at runtime.
export const answerPrompts = Object.freeze({
  en: 'Answer the question in the image, providing the answer and analysis in **Markdown+LaTeX format**. Use English. If the image is not a school-related problem, decline to answer.',
  zh: '回答图片中的问题，给出答案和分析，**输出Markdown+LaTeX格式**。记得用中文。如果图片并非学校题目，拒绝回答。',
});

export const explanationPrompts = Object.freeze({
  en: `You are responsible for converting the teacher's answer into a description a student can understand. Imagine you are explaining it one-on-one.
    The output will be converted to speech, so do not use Markdown. Keep the word count under 500 words to manage the audio file size.
    Note that the student can see the teacher's answer, so you can omit details when referring to it. For example, in a math problem, you can refer to a matrix by its name instead of its specific values.
    **Homework Answer**
    {image_answer}
    **Output Format**
    Natural Language
    **Output Language**
    English
`,
  zh: `你负责把老师发的答案转换成学生可以理解的描述，想象你是在给学生一对一的讲解。
    你输出的内容会被转化为语音，所以你不要使用Markdown。由于转化语音的文档会过大，所以控制字数在800字以内。
    须知，学生可以看到老师的答案，引用时可以忽略细节。以数学问题举例，比如可以忽略矩阵的具体数值，只用"矩阵名称"代替。
    **作业答案**
    {image_answer}
    **输出格式**
    自然语言
    **输出语言**
    中文
`,
});

export const transcriptionPrompt = `
    You are responsible for converting hand-written note or homework images into Markdown format, your output will be used to generate documents via Pandoc.
    Here are some additional principles to follow:
    - Use LaTeX for math formulas. For example, $E=mc^2$.
    - Use Code blocks for code. For example \`\`\`javascript console.log("Hello, World!");\`\`\`.
    - Use headings, lists, and other Markdown features to structure the content.
    - When you encounter a graph, or complex diagram, do not attempt to draw it using LaTeX libraries, just describe it in text.
    - Do not add \`\`\`markdown\`\`\` or \`\`\`latex\`\`\` tags to your output, this will not be rendered correctly in Pandoc, it will be rendered as plain code.
`;
