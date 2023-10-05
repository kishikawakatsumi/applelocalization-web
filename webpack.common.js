const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebbackPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    index: "./frontend/index.js",
  },
  output: {
    globalObject: "self",
    filename: "static/[name].[contenthash].js",
    path: path.resolve(__dirname, "dist"),
    publicPath: "/",
    clean: true,
  },
  module: {
    rules: [
      { test: /\.html$/, loader: "handlebars-loader" },
      {
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, "css-loader"],
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: "asset/resource",
      },
    ],
  },
  plugins: [
    new CopyWebbackPlugin({
      patterns: [
        { from: "frontend/templates/*.*", to: "templates/[name][ext]" },
        { from: "frontend/static/*.*", to: "[name][ext]" },
      ],
    }),
    new HtmlWebpackPlugin({
      chunks: ["index"],
      filename: "templates/index.html",
      template: "frontend/index.html",
    }),
    new MiniCssExtractPlugin({
      filename: "[name].[contenthash].css",
    }),
  ],
};
