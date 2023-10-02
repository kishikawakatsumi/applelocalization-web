"use strict";

import { library, dom } from "@fortawesome/fontawesome-svg-core";
import {
  faSearch,
  faToolbox,
  faAngleDown,
  faHeart,
} from "@fortawesome/pro-solid-svg-icons";
import { faMessageSmile, faAt } from "@fortawesome/pro-regular-svg-icons";
import {
  faGlobe,
  faMobile,
  faDesktop,
  faSliders,
  faMonitorHeartRate,
} from "@fortawesome/pro-light-svg-icons";
import { faSpinnerThird } from "@fortawesome/pro-duotone-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

library.add(
  faSearch,
  faToolbox,
  faAngleDown,
  faHeart,

  faMessageSmile,
  faAt,

  faGlobe,
  faMobile,
  faDesktop,
  faSliders,
  faMonitorHeartRate,

  faSpinnerThird,

  faGithub
);
dom.watch();
